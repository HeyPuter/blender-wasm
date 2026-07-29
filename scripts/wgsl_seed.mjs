// Generate web/wgsl-cache.json: boot, exercise a broad shader surface
// (orbit/grab/edit-mode, all workspaces incl. shading/rendered), then dump
// globalThis.__WGSL_CACHE__. Rerun whenever shaders or the translator change
// (also bump the v1 salt in webgpu_shader.cc if OUTPUT semantics changed).
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8177"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/wgsl_seed.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));
await page.goto("http://localhost:8177/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();
const vp = { x: box.x + 700, y: box.y + 400 };

// viewport interactions: orbit, pan, zoom, select, grab
await page.mouse.move(vp.x, vp.y); await settle(500);
await page.mouse.down({ button: "middle" });
await page.mouse.move(vp.x + 120, vp.y + 40, { steps: 10 });
await page.mouse.up({ button: "middle" }); await settle();
await page.keyboard.down("Shift");
await page.mouse.down({ button: "middle" });
await page.mouse.move(vp.x + 60, vp.y - 30, { steps: 8 });
await page.mouse.up({ button: "middle" });
await page.keyboard.up("Shift"); await settle();
await page.mouse.wheel(0, -2); await settle(800);
await page.mouse.click(vp.x, vp.y); await settle();
await page.keyboard.press("g");
await page.mouse.move(vp.x + 60, vp.y, { steps: 6 });
await page.keyboard.press("Escape"); await settle();
// edit mode round trip (edit cage, points, wireframe variants)
await page.keyboard.press("Tab"); await settle(3000);
await page.keyboard.press("a"); await settle(800);
await page.keyboard.press("Tab"); await settle(2000);
// all workspaces (incl. shading rendered/material preview + node editors)
for (let i = 0; i < 11; i++) {
  await page.keyboard.down("Control");
  await page.keyboard.press("PageDown");
  await page.keyboard.up("Control");
  await settle(i === 5 ? 15000 : 4500); // shading workspace compiles EEVEE
}
console.log("dumping cache…");
const entries = await page.evaluate(() => JSON.stringify([...globalThis.__WGSL_CACHE__.entries()]));
writeFileSync("web/wgsl-cache.json", entries);
console.log("wgsl-cache.json entries=" + JSON.parse(entries).length +
            " bytes=" + entries.length);
await browser.close(); srv.kill(); console.log("done");
