import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8133"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/gizmo_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8133/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const shot = (n) => page.locator("#canvas").screenshot({ path: `web/gz_${n}.png` });
const settle = (ms = 1300) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();

await page.mouse.click(box.x + 28, box.y + 164); await settle(2500); // Move tool
await shot("1_tool");
// Hover the Z arrow tip repeatedly (warms the one-round-stale query cache).
for (let i = 0; i < 6; i++) {
  await page.mouse.move(box.x + 652 + (i % 2), box.y + 366);
  await settle(350);
}
await shot("2_hover");
// Drag the Z arrow upward.
await page.mouse.down();
await page.mouse.move(box.x + 652, box.y + 200, { steps: 20 });
await settle(600);
await shot("3_mid_drag");
await page.mouse.up();
await settle(1500);
await shot("4_dragged");
await browser.close(); srv.kill(); console.log("done");
