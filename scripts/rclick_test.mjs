// Interactive viewport perf: MMB pan + move-tool drag with continuous mouse
// movement, WGPU_STATS per-frame telemetry. Console → /tmp/rclick_test.log.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8173"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const full = createWriteStream("/tmp/rclick_test.log");
await page.addInitScript(() => { window.__CAPENV = { WGPU_STATS: "1" }; });
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8173/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();
const vp = { x: box.x + 700, y: box.y + 400 };

// listener AFTER our handler: defaultPrevented reflects the page handler
await page.evaluate(() => {
  window.addEventListener("contextmenu", (e) => console.log("CTXMENU defaultPrevented=" + e.defaultPrevented));
});
await page.mouse.move(vp.x, vp.y); await settle(400);
await page.mouse.click(vp.x, vp.y); await settle();
await page.mouse.click(vp.x, vp.y, { button: "right" }); await settle(1500);
await page.locator("#canvas").screenshot({ path: "web/rclick_menu.png" });
await browser.close(); srv.kill(); console.log("done");
