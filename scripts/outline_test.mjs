import { spawn } from "node:child_process";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8117"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-experimental-webassembly-jspi", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
page.on("console", () => {});
await page.goto("http://localhost:8117/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
// Dismiss splash with Escape (more reliable than hitting Continue).
await page.keyboard.press("Escape");
await new Promise(r => setTimeout(r, 1200));
await page.mouse.move(box.x + 620, box.y + 380);
await page.mouse.wheel(0, -1);
await new Promise(r => setTimeout(r, 500));
await page.locator("#canvas").screenshot({ path: "web/outline_t0.png" });
await new Promise(r => setTimeout(r, 3000));
await page.locator("#canvas").screenshot({ path: "web/outline_t3.png" });
await browser.close();
srv.kill();
