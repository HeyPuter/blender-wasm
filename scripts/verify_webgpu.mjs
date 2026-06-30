// Probe whether headless Chromium on this box exposes a working WebGPU adapter
// (software, via Dawn → Vulkan → bundled SwiftShader ICD, since there's no GPU).
// Uses the FULL chromium build (the headless-shell build lacks libvk_swiftshader).
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8092;
const PAGE = process.argv[2] || "webgpu-probe.html";
const EXPECT = process.argv[3] || "WEBGPU OK";

// Full chromium build + its bundled software Vulkan ICD.
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const exe = `${chromeDir}/chrome`;
const icd = `${chromeDir}/vk_swiftshader_icd.json`;
if (!existsSync(exe)) { console.log("FAIL: full chromium not found at", exe); process.exit(1); }

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 600));

let exitCode = 1;
const browser = await chromium.launch({
  executablePath: exe,
  // Point Dawn's Vulkan backend at the bundled SwiftShader software ICD.
  env: { ...process.env, VK_ICD_FILENAMES: icd },
  args: [
    "--headless=new",
    "--no-sandbox",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--disable-vulkan-surface",
  ],
});
try {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => console.log("[browser]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/${PAGE}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => /OK|FAIL/.test(document.title), null, { timeout: 40000 });
  const r = await page.evaluate(() => window.__WEBGPU__ || window.__WGPU_WASM__);
  const title = await page.title();
  await page.screenshot({ path: join(WEB, "webgpu-shot.png") });
  console.log("result:", JSON.stringify(r));
  console.log("title:", title, "(expected:", EXPECT + ")");
  if (title === EXPECT) { console.log("WEBGPU VERIFY PASS"); exitCode = 0; }
  else console.log("WEBGPU VERIFY FAIL");
} catch (e) {
  console.log("WEBGPU VERIFY FAIL:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(exitCode);
}
