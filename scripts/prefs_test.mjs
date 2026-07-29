import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8137"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/prefs_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8137/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const shot = (n) => page.locator("#canvas").screenshot({ path: `web/pf_${n}.png` });
const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();

// Edit > Preferences...
await page.mouse.click(box.x + 75, box.y + 10); await settle();
await shot("1_edit_menu");
// Preferences… is 2nd from the menu bottom ("Project Setup…" sits below it);
// keyboard selection avoids pixel-position fragility.
await page.keyboard.press("ArrowUp"); await settle(300);
await page.keyboard.press("ArrowUp"); await settle(300);
await page.keyboard.press("Enter"); await settle(4000);
await shot("2_preferences");
// Fullscreen temp spaces close via the header "Back to Previous" button
// (Escape does not close them, same as desktop Blender).
await page.mouse.move(box.x + 800, box.y + 400); await settle(400);
await page.mouse.click(box.x + 320, box.y + 12); await settle(1500);
await shot("3_back");

// F12 render (EEVEE) — takes a while (lazy shader compiles + render).
await page.keyboard.press("F12"); await settle(150000);
await shot("4_render");
await page.mouse.click(box.x + 320, box.y + 12); await settle(1500);
await shot("5_back_from_render");
await browser.close(); srv.kill(); console.log("done");
