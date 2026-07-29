// Animation playback perf: spacebar over the viewport, sample WGPU_STATS
// frame dt for ~15s, then stop. Console → /tmp/playback_test.log.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8143"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/playback_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.addInitScript(() => { window.__CAPENV = { WGPU_STATS: "1" }; });
await page.goto("http://localhost:8143/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle(1500);
await page.mouse.move(box.x + 700, box.y + 400); await settle(500);
console.log("PLAYBACK START");
await page.keyboard.press(" ");
await settle(15000);
await page.keyboard.press(" "); // stop
await settle(1000);
await page.locator("#canvas").screenshot({ path: "web/playback.png" });
await browser.close(); srv.kill(); console.log("done");
