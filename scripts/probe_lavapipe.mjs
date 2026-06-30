// Probe: does chromium's WebGPU work on lavapipe (Mesa software Vulkan) instead
// of SwiftShader, and what limits does it report? lavapipe advertises far higher
// compute/storage limits than SwiftShader, which is what EEVEE-Next's compute
// passes need. Usage: node scripts/probe_lavapipe.mjs [swiftshader|lavapipe]
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8099;
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const mode = process.argv[2] || "lavapipe";

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 600));

const swiftArgs = ["--headless=new", "--no-sandbox", "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-vulkan-surface"];
const lavaArgs = ["--headless=new", "--no-sandbox", "--enable-unsafe-webgpu",
  "--enable-features=Vulkan", "--use-angle=vulkan", "--disable-vulkan-surface",
  "--enable-features=VulkanFromANGLE"];

const env = { ...process.env };
if (mode === "lavapipe") {
  env.VK_ICD_FILENAMES = "/usr/share/vulkan/icd.d/lvp_icd.json";
  env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/lvp_icd.json";
} else {
  env.VK_ICD_FILENAMES = `${chromeDir}/vk_swiftshader_icd.json`;
}

console.log(`mode=${mode}`);
const browser = await chromium.launch({
  executablePath: `${chromeDir}/chrome`,
  env,
  args: mode === "lavapipe" ? lavaArgs : swiftArgs,
});
try {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => { if (m.text().includes("PROBE")) console.log(m.text()); });
  await page.goto(`http://localhost:${PORT}/blank.html`, { waitUntil: "load", timeout: 30000 });
  const res = await page.evaluate(async () => {
    if (!navigator.gpu) return { err: "no navigator.gpu" };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { err: "no adapter" };
    const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
    const L = a.limits;
    return {
      vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
      maxStorageTexturesPerShaderStage: L.maxStorageTexturesPerShaderStage,
      maxComputeWorkgroupSizeX: L.maxComputeWorkgroupSizeX,
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
    };
  });
  console.log("PROBE result:", JSON.stringify(res, null, 2));
} catch (e) {
  console.log("PROBE ERROR:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(0);
}
