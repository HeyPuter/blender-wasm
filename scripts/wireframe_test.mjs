// Cycle through all workspaces with Ctrl+PageDown, screenshot each.
// Screenshots: web/wf_NN.png. Console → /tmp/wireframe_test.log.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8181"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/wireframe_test.log");
let errCount = 0;
await page.addInitScript(() => { window.__CAPENV = {};
  window.__BARGS = ["--python-expr", "import bpy\n[setattr(a.spaces[0].shading,'type','WIREFRAME') for w in bpy.data.workspaces for s in w.screens for a in s.areas if a.type=='VIEW_3D']"]; });
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => { errCount++; full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"); });
await page.goto("http://localhost:8181/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
await page.keyboard.press("Escape"); await new Promise(r => setTimeout(r, 1500));
const settle = (ms) => new Promise(r => setTimeout(r, ms));
// Mouse over the viewport so workspace-cycle shortcuts apply globally.
await page.mouse.move(box.x + 700, box.y + 400); await settle(500);
const names = ["layout", "layout2"];
for (let i = 0; i < names.length; i++) {
  const t0 = Date.now();
  if (i > 0) {
    await page.keyboard.down("Control");
    await page.keyboard.press("PageDown");
    await page.keyboard.up("Control");
  }
  await settle(5000);
  await page.locator("#canvas").screenshot({ path: `web/wf_${String(i).padStart(2, "0")}_${names[i]}.png` });
  console.log(`ws ${names[i]}: ${Date.now() - t0}ms errs=${errCount}`);
}
await browser.close(); srv.kill(); console.log("done");
