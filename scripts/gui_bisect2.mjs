import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8127"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/gui_bisect2_console.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8127/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const shot = (n) => page.locator("#canvas").screenshot({ path: `web/bis2_${n}.png` });
const settle = (ms = 1300) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();

// Move tool on (cube already selected at startup).
await page.mouse.click(box.x + 28, box.y + 164); await settle(2000);
await shot("A_tool");
// Drag ON THE CUBE BODY (tool-drag = tweak move).
await page.mouse.move(box.x + 654, box.y + 452);
await page.mouse.down();
await page.mouse.move(box.x + 780, box.y + 400, { steps: 12 });
await page.mouse.up();
await settle(1500);
await shot("B_tooldrag");
// Is input alive? Open the File menu.
await page.mouse.click(box.x + 30, box.y + 10); await settle();
await shot("C_filemenu");
await browser.close(); srv.kill(); console.log("done");
