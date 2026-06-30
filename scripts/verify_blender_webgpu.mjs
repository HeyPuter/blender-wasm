// Browser harness for full Blender → WASM with a REAL WebGPU device handed in
// from JS. Confirms the deliverable: Blender boots in chromium, loads the scene,
// runs the render pipeline, and the WebGPU backend's context acquires a real
// device (device_ != null, queue created). Uses the full chromium build + its
// bundled SwiftShader software Vulkan ICD (no GPU on the box), same as
// verify_webgpu.mjs. EEVEE pixels need the rest of the backend; this proves the
// device path works end-to-end through Blender.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8093;

const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const exe = `${chromeDir}/chrome`;
const icd = `${chromeDir}/vk_swiftshader_icd.json`;
if (!existsSync(exe)) { console.log("FAIL: full chromium not found at", exe); process.exit(1); }

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 700));

let exitCode = 1;
const browser = await chromium.launch({
  executablePath: exe,
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

  // Detect the verdict from the NODE-side console stream, not via
  // page.waitForFunction: without PROXY_TO_PTHREAD, Blender runs on the browser
  // main thread and freezes the page's JS event loop once it's deep in the
  // render, so in-page polling can't observe the flag. The console events still
  // reach node (they're emitted before/around the freeze).
  const DEADLINE = 220000;
  let verdict = null;
  const done = new Promise((resolve) => {
    const finish = (v) => { if (!verdict) { verdict = v; resolve(v); } };
    page.on("console", (m) => {
      const t = m.text();
      console.log("[browser]", t);
      if (t.includes("WEBGPU_CONTEXT") && t.includes("real device acquired")) finish("device");
      else if (t.includes("WEBGPU_CONTEXT no device")) finish("deviceless");
    });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    setTimeout(() => finish("timeout"), DEADLINE);
  });

  await page.goto(`http://localhost:${PORT}/blender-webgpu.html`, { waitUntil: "load", timeout: 60000 });
  const st = await done;
  console.log("verdict:", st);
  // DIAG: after the device is acquired, keep logging to map the NEXT backend
  // blocker (what the render hits in the WebGPU backend after context creation).
  if (process.env.DIAG && st === "device") {
    console.log("--- DIAG: capturing post-device console for 100s ---");
    await new Promise((r) => setTimeout(r, 100000));
  }
  if (st === "device") {
    console.log("BLENDER WEBGPU VERIFY PASS — real WebGPU device acquired inside Blender's render pipeline");
    exitCode = 0;
  } else if (st === "deviceless") {
    console.log("BLENDER WEBGPU VERIFY FAIL — context came up device-less (handoff didn't reach wasm)");
  } else {
    console.log("BLENDER WEBGPU VERIFY FAIL — timed out before context creation");
  }
} catch (e) {
  console.log("BLENDER WEBGPU VERIFY FAIL:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(exitCode);
}
