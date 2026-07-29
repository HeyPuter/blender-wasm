// Boot the full Blender GUI (web/blender-gui.html) on the REAL GPU in headed
// Playwright, wait for the window backbuffer to appear, then screenshot the
// canvas. Console → /tmp/gui_console.log; screenshot → web/gui_screenshot.png.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8107;
const chromeDir = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const WAIT_S = parseInt(process.env.GUI_WAIT || "180", 10);

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: `${chromeDir}/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-experimental-webassembly-jspi", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});

let code = 1;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  const full = createWriteStream("/tmp/gui_console.log");
  page.on("console", (m) => {
    const t = m.text();
    full.write(t + "\n");
    if (/WEBGPU_CONTEXT|WGPU_PRESENT|Blender|ABORT|Error|error:|Traceback/.test(t)) {
      console.log("  ·", t.slice(0, 200));
    }
  });
  page.on("pageerror", (e) => console.log("[pageerror]", (e.stack || e.message).slice(0, 4000)));

  await page.goto(`http://localhost:${PORT}/blender-gui.html`, { waitUntil: "load", timeout: 60000 });

  // Wait for first present (or timeout), polling the page state.
  const deadline = Date.now() + WAIT_S * 1000;
  let state = {};
  while (Date.now() < deadline) {
    state = await page.evaluate(() => window.__BGUI__ || {});
    if (state.window) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("state:", JSON.stringify(state));
  // Extra settle time for a few frames.
  await new Promise((r) => setTimeout(r, 5000));

  // Drive input: click the splash "Continue" (center-ish), then move the mouse
  // around the viewport and middle-drag to orbit.
  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  const cx = box.x, cy = box.y;
  await page.evaluate(() => {
    const c = document.getElementById("canvas");
    c.addEventListener("mousedown", (e) => console.log("JS-LEVEL mousedown", e.clientX, e.clientY));
    c.addEventListener("mouseup", (e) => console.log("JS-LEVEL mouseup"));
  });
  await page.mouse.click(cx + 768, cy + 620);          // Continue button
  await new Promise((r) => setTimeout(r, 1500));
  await page.mouse.move(cx + 600, cy + 400);
  await page.mouse.click(cx + 600, cy + 400);          // click in viewport
  await new Promise((r) => setTimeout(r, 1500));
  await canvas.screenshot({ path: join(WEB, "gui_screenshot_after_click.png") });
  console.log("saved web/gui_screenshot_after_click.png");

  await page.locator("#canvas").screenshot({ path: join(WEB, "gui_screenshot.png") });
  console.log("saved web/gui_screenshot.png");
  code = state.window ? 0 : 2;
}
catch (e) {
  console.log("ERROR:", e.message);
}
finally {
  await browser.close().catch(() => {});
  srv.kill();
}
process.exit(code);
