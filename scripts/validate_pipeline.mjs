// Validate that a translated Blender shader's vertex+fragment WGSL can form a
// real WGPURenderPipeline in browser WebGPU (the next step after module
// validation). Args: <vertex.wgsl> <fragment.wgsl>. chromium+SwiftShader.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8095;
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const [vertPath, fragPath] = process.argv.slice(2);
if (!vertPath || !fragPath) { console.log("usage: validate_pipeline.mjs <vert.wgsl> <frag.wgsl>"); process.exit(1); }

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({
  executablePath: `${chromeDir}/chrome`,
  env: { ...process.env, VK_ICD_FILENAMES: `${chromeDir}/vk_swiftshader_icd.json` },
  args: ["--headless=new", "--no-sandbox", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu",
         "--enable-features=Vulkan", "--disable-vulkan-surface"],
});
let code = 1;
try {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/blank.html`, { waitUntil: "load", timeout: 30000 });
  const vert = readFileSync(vertPath, "utf8");
  const frag = readFileSync(fragPath, "utf8");
  const res = await page.evaluate(async ({ vert, frag }) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    device.pushErrorScope("validation");
    const vmod = device.createShaderModule({ code: vert });
    const fmod = device.createShaderModule({ code: frag });
    let pipeError = null;
    try {
      device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: vmod, entryPoint: "main",
          buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
        },
        fragment: { module: fmod, entryPoint: "main", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list" },
      });
    } catch (e) { pipeError = String(e); }
    const scopeErr = await device.popErrorScope();
    return { pipeError, scopeErr: scopeErr ? scopeErr.message : null };
  }, { vert, frag });
  console.log("debug res:", JSON.stringify(res));
  if (!res.pipeError && !res.scopeErr) {
    console.log("RENDER PIPELINE OK — modules form a valid WGPURenderPipeline");
    code = 0;
  } else {
    console.log("PIPELINE FAIL:", res.pipeError || res.scopeErr);
  }
} catch (e) {
  console.log("EVALUATE THREW:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(code);
}
