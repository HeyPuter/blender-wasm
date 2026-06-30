// Validate that Tint-generated WGSL (from Blender shaders) is accepted by real
// browser WebGPU (createShaderModule + getCompilationInfo). Args: .wgsl paths.
// Serves a localhost page (WebGPU needs a secure context — NOT available on
// about:blank). chromium + SwiftShader.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8094;
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const files = process.argv.slice(2);
if (!files.length) { console.log("usage: validate_wgsl.mjs <file.wgsl>..."); process.exit(1); }

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({
  executablePath: `${chromeDir}/chrome`,
  env: { ...process.env, VK_ICD_FILENAMES: `${chromeDir}/vk_swiftshader_icd.json` },
  args: ["--headless=new", "--no-sandbox", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu",
         "--enable-features=Vulkan", "--disable-vulkan-surface"],
});
let fail = 0, validated = 0;
try {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/blank.html`, { waitUntil: "load", timeout: 30000 });
  const hasGpu = await page.evaluate(() => !!navigator.gpu);
  if (!hasGpu) { console.log("FATAL: navigator.gpu unavailable"); throw new Error("no webgpu"); }
  for (const path of files) {
    const wgsl = readFileSync(path, "utf8");
    const res = await page.evaluate(async (code) => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const mod = device.createShaderModule({ code });
      const info = await mod.getCompilationInfo();
      return info.messages.filter(m => m.type === "error").map(m => `L${m.lineNum}: ${m.message.trim().slice(0,140)}`);
    }, wgsl);
    const tag = path.replace(/.*\//, "");
    validated++;
    if (res.length === 0) { console.log(`OK    ${tag}`); }
    else { fail++; console.log(`FAIL  ${tag}`); res.slice(0,2).forEach(e => console.log("        " + e)); }
  }
} catch (e) {
  console.log("RUNNER ERROR:", e.message); fail++;
} finally {
  await browser.close();
  srv.kill();
  console.log(`validated=${validated} failed=${fail}`);
  process.exit(fail === 0 && validated > 0 ? 0 : 1);
}
