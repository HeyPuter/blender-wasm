// Try to force chromium's WebGPU (Dawn) onto lavapipe (system Vulkan) instead of
// the bundled SwiftShader. Probes adapter.info + limits for several flag sets.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8088;
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 600));

const lavaEnv = {
  ...process.env,
  VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/lvp_icd.json",
  VK_DRIVER_FILES: "/usr/share/vulkan/icd.d/lvp_icd.json",
  VK_LOADER_DRIVERS_SELECT: "*lvp*",
  LIBGL_ALWAYS_SOFTWARE: "1",
};

const flagSets = {
  A_disable_swrast: [
    "--headless=new", "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu",
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist",
    "--disable-software-rasterizer", "--use-angle=vulkan",
  ],
  B_vulkan_angle: [
    "--headless=new", "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu",
    "--enable-unsafe-webgpu", "--enable-features=Vulkan,VulkanFromANGLE",
    "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=vulkan",
    "--disable-vulkan-fallback-to-gl-for-testing",
  ],
  C_force_vulkan_only: [
    "--headless=new", "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu",
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist",
    "--disable-software-rasterizer",
    "--enable-dawn-features=use_vulkan_memory_model",
    "--disable-dawn-features=disallow_unsafe_apis",
  ],
};

async function probe(name, args) {
  console.log(`\n===== ${name} =====`);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: `${chromeDir}/chrome`, env: lavaEnv, args });
  } catch (e) { console.log("launch fail:", e.message.slice(0, 120)); return; }
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://localhost:${PORT}/blank.html`, { waitUntil: "load", timeout: 20000 });
    const res = await page.evaluate(async () => {
      if (!navigator.gpu) return { err: "no navigator.gpu" };
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { err: "no adapter" };
      const info = a.info || {};
      return {
        desc: info.description || info.device || "", vendor: info.vendor || "",
        backend: info.backendType || info.architecture || "",
        storTex: a.limits.maxStorageTexturesPerShaderStage,
        wgX: a.limits.maxComputeWorkgroupSizeX,
      };
    });
    console.log(JSON.stringify(res));
  } catch (e) { console.log("probe err:", e.message.slice(0, 140)); }
  finally { await browser.close(); }
}

for (const [name, args] of Object.entries(flagSets)) {
  await probe(name, args);
}
srv.kill();
process.exit(0);
