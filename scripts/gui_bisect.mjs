import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8123"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/gui_bisect_console.log");
page.on("console", (m) => full.write(m.text() + "\n"));
await page.goto("http://localhost:8123/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const shot = (n) => page.locator("#canvas").screenshot({ path: `web/bis_${n}.png` });
const settle = (ms = 1300) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();

// A: isolated rotate (cube selected by default at startup).
await page.mouse.move(box.x + 654, box.y + 452);
await page.keyboard.press("r");
await page.mouse.move(box.x + 780, box.y + 380, { steps: 8 });
await settle(500);
await page.mouse.click(box.x + 780, box.y + 380);
await settle();
await shot("A_rotate");

// B: file menu right after.
await page.mouse.click(box.x + 30, box.y + 10); await settle();
await shot("B_filemenu");
await page.keyboard.press("Escape"); await settle(600);

// C: viewport drag (the suspected poison), then file menu again.
await page.mouse.move(box.x + 600, box.y + 500);
await page.mouse.down();
await page.mouse.move(box.x + 700, box.y + 430, { steps: 10 });
await page.mouse.up();
await settle();
await shot("C_after_drag");
await page.mouse.click(box.x + 30, box.y + 10); await settle();
await shot("D_filemenu_after_drag");
await browser.close(); srv.kill(); console.log("done");
