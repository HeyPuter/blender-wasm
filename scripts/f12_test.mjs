// Fast F12 verification: shrink the render via --python-expr, render, verify
// the result shows non-checkerboard pixels in the render editor.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8141"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addInitScript(`window.__BARGS = ["--python-expr",
  "import bpy; s=bpy.context.scene; s.render.resolution_x=320; s.render.resolution_y=240; s.render.resolution_percentage=100; s.eevee.taa_render_samples=4"];`);
const page = await ctx.newPage();
const full = createWriteStream("/tmp/f12_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8141/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
await page.keyboard.press("Escape"); await new Promise(r => setTimeout(r, 1500));
await page.keyboard.press("F12");
// Poll for up to 4 minutes, screenshotting periodically.
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 15000));
  await page.locator("#canvas").screenshot({ path: `web/f12_${String(i).padStart(2, "0")}.png` });
}
await browser.close(); srv.kill(); console.log("done");
