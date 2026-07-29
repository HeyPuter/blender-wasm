// Interactive viewport perf: MMB pan + move-tool drag with continuous mouse
// movement, WGPU_STATS per-frame telemetry. Console → /tmp/swiftshader_test.log.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8171"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu",
         "--use-webgpu-adapter=swiftshader", "--window-size=1700,1000"],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const full = createWriteStream("/tmp/swiftshader_test.log");
await page.addInitScript(() => { window.__CAPENV = { WGPU_STATS: "1" }; });
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8171/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();
await page.locator("#canvas").screenshot({ path: "web/swiftshader_boot.png" });
const vp = { x: box.x + 700, y: box.y + 400 };

const mark = (m) => page.evaluate((t) => console.log("MARK " + t), m);

// Phase A: idle hover (mouse moving over viewport, no buttons)
await mark("HOVER_START " + Date.now());
for (let i = 0; i < 40; i++) {
  await page.mouse.move(vp.x + (i % 20) * 8, vp.y + (i % 10) * 6);
  await new Promise(r => setTimeout(r, 25));
}
await mark("HOVER_END " + Date.now());
await settle(1000);

// Phase B: MMB pan
await mark("PAN_START " + Date.now());
await page.mouse.move(vp.x, vp.y);
await page.mouse.down({ button: "middle" });
for (let i = 0; i < 40; i++) {
  await page.mouse.move(vp.x + i * 4, vp.y + Math.sin(i / 5) * 40);
  await new Promise(r => setTimeout(r, 25));
}
await page.mouse.up({ button: "middle" });
await mark("PAN_END " + Date.now());
await settle(1000);

// Phase C: select cube then G-drag with mouse movement
await page.mouse.move(vp.x, vp.y); await settle(300);
await page.mouse.click(vp.x, vp.y); await settle();
await mark("DRAG_START " + Date.now());
await page.keyboard.press("g");
for (let i = 0; i < 40; i++) {
  await page.mouse.move(vp.x + i * 3, vp.y - i * 2);
  await new Promise(r => setTimeout(r, 25));
}
await page.keyboard.press("Enter");
await mark("DRAG_END " + Date.now());
await settle(1000);
await browser.close(); srv.kill(); console.log("done");
