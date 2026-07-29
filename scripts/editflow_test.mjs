// Editing critical path: select, grab, undo, add object, edit mode, extrude,
// undo chain. Screenshots web/ef_*.png; console → /tmp/editflow_test.log.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8145"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/editflow_test.log");
let errs = 0;
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => { errs++; full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"); });
await page.goto("http://localhost:8145/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1400) => new Promise(r => setTimeout(r, ms));
const shot = async (n) => {
  await page.locator("#canvas").screenshot({ path: `web/ef_${n}.png` });
  console.log(`step ${n}: errs=${errs}`);
};
const vp = { x: box.x + 700, y: box.y + 400 }; // viewport center ~ cube
await page.keyboard.press("Escape"); await settle();

// 1. click-select the cube
await page.mouse.move(vp.x, vp.y); await settle(400);
await page.mouse.click(vp.x, vp.y); await settle();
await shot("01_select");
// 2. grab: G, move, confirm click
await page.keyboard.press("g"); await settle(600);
await page.mouse.move(vp.x + 150, vp.y - 60, { steps: 10 }); await settle(600);
await page.mouse.click(vp.x + 150, vp.y - 60); await settle();
await shot("02_grab");
// 3. undo the grab
await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
await settle();
await shot("03_undo_grab");
// 4. add a UV sphere: Shift+A, Mesh submenu (first item -> ArrowRight), UV Sphere (2nd)
await page.keyboard.down("Shift"); await page.keyboard.press("a"); await page.keyboard.up("Shift");
await settle(800);
await shot("04_add_menu");
await page.keyboard.press("ArrowDown"); await settle(300);
await page.keyboard.press("ArrowRight"); await settle(300);
await page.keyboard.press("ArrowDown"); await settle(300);
await page.keyboard.press("ArrowDown"); await settle(300);
await page.keyboard.press("Enter"); await settle(1800);
await shot("05_added_sphere");
// 5. edit mode on the new object
await page.keyboard.press("Tab"); await settle(2500);
await shot("06_editmode");
// 6. select all + extrude along Z
await page.keyboard.press("a"); await settle(800);
await page.keyboard.press("e"); await settle(600);
await page.keyboard.type("1"); await settle(400);
await page.keyboard.press("Enter"); await settle(1200);
await shot("07_extrude");
// 7. back to object mode
await page.keyboard.press("Tab"); await settle(1500);
await shot("08_objectmode");
// 8. undo chain x4
for (let i = 0; i < 4; i++) {
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  await settle(900);
}
await shot("09_undo_chain");
// 9. redo x2
for (let i = 0; i < 2; i++) {
  await page.keyboard.down("Control"); await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift"); await page.keyboard.up("Control");
  await settle(900);
}
await shot("10_redo");
await browser.close(); srv.kill(); console.log("done errs=" + errs);
