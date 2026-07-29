// Python console typing + rendered-viewport test. web/cr_*.png.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8157"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/console_render_test.log");
let errs = 0;
await page.addInitScript(() => { window.__CAPENV = { GHOST_LOG_KEYS: "1" }; });
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => { errs++; full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"); });
await page.goto("http://localhost:8157/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1400) => new Promise(r => setTimeout(r, ms));
const shot = async (n) => {
  await page.locator("#canvas").screenshot({ path: `web/cr_${n}.png` });
  console.log(`step ${n}: errs=${errs}`);
};
await page.keyboard.press("Escape"); await settle();
await page.mouse.move(box.x + 700, box.y + 400); await settle(400);

// Scripting workspace: Ctrl+PageUp once wraps from Layout to Scripting (last tab).
await page.keyboard.down("Control"); await page.keyboard.press("PageUp"); await page.keyboard.up("Control");
await settle(4000);
await shot("01_scripting");
// click into the interactive console (left column, lower area)
await page.mouse.move(box.x + 250, box.y + 700); await settle(400);
await page.mouse.click(box.x + 250, box.y + 700); await settle(800);
// add Suzanne via console
await page.keyboard.type("bpy.ops.mesh.primitive_monkey_add(location=(3,0,1))", { delay: 15 });
await settle(400);
await shot("02_typed");
await page.keyboard.press("Enter"); await settle(3000);
await shot("03_monkey");
// switch Layout viewport to RENDERED shading via console
await page.keyboard.type(
  "[setattr(a.spaces[0].shading,'type','RENDERED') for s in bpy.data.workspaces['Layout'].screens for a in s.areas if a.type=='VIEW_3D']",
  { delay: 10 });
await page.keyboard.press("Enter"); await settle(1500);
// go to Layout (Ctrl+PageDown wraps forward from Scripting to Layout)
await page.keyboard.down("Control"); await page.keyboard.press("PageDown"); await page.keyboard.up("Control");
await settle(4000);
await shot("04_layout_rendered_warm");
await settle(20000); // EEVEE shader compiles + sampling
await shot("05_layout_rendered");
await browser.close(); srv.kill(); console.log("done errs=" + errs);
