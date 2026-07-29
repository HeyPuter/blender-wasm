import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8131"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/editmode_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8131/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const shot = (n) => page.locator("#canvas").screenshot({ path: `web/em_${n}.png` });
const settle = (ms = 1400) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();

await page.mouse.move(box.x + 654, box.y + 452);
await page.keyboard.press("Tab"); await settle(2500);   // edit mode, all selected
await shot("1_editmode");
await page.keyboard.press("Alt+a"); await settle();     // deselect all
await shot("2_deselected");
// Click the cube's front-top-right corner (approx from edit view).
await page.mouse.click(box.x + 719, box.y + 397); await settle();
await shot("3_vert_click");
// Box-select the top half via drag (B then drag).
await page.keyboard.press("b"); await settle(400);
await page.mouse.move(box.x + 560, box.y + 360);
await page.mouse.down();
await page.mouse.move(box.x + 760, box.y + 430, { steps: 8 });
await page.mouse.up();
await settle();
await shot("4_boxsel");
await browser.close(); srv.kill(); console.log("done");
