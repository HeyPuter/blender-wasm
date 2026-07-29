import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8119"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/select_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
await page.goto("http://localhost:8119/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
await page.keyboard.press("Escape");            // dismiss splash
await new Promise(r => setTimeout(r, 1500));
// Click empty space first (deselect), then the cube (startup position ~630,375).
await page.mouse.click(box.x + 1000, box.y + 700);
await new Promise(r => setTimeout(r, 1500));
await page.locator("#canvas").screenshot({ path: "web/seltest_1_deselected.png" });
await page.mouse.click(box.x + 654, box.y + 452);
await new Promise(r => setTimeout(r, 2000));
await page.locator("#canvas").screenshot({ path: "web/seltest_2_selected.png" });
await browser.close();
srv.kill();
console.log("done");
