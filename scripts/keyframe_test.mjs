// Insert a keyframe on the cube; keyframe diamonds in the timeline exercise
// gpu_shader_keyframe_shape (gl_PointCoord SDF). web/kf_*.png.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8147"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/keyframe_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.addInitScript(() => { window.__CAPENV = { WGPU_LOG_POINTS: "1" }; });
await page.goto("http://localhost:8147/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1400) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();
// select cube, I -> insert keyframe menu -> first entry via Enter
await page.mouse.move(box.x + 700, box.y + 400); await settle(400);
await page.mouse.click(box.x + 700, box.y + 400); await settle();
await page.keyboard.press("i"); await settle(900);
await page.locator("#canvas").screenshot({ path: "web/kf_1_menu.png" });
await page.keyboard.press("ArrowDown"); await settle(300);
await page.keyboard.press("Enter"); await settle(1800);
await page.locator("#canvas").screenshot({ path: "web/kf_2_inserted.png" });
await browser.close(); srv.kill(); console.log("done");
