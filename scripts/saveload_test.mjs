// Save/load round trip: move cube, Ctrl+S (fullscreen file browser), accept,
// verify saved toast; then Ctrl+O and reopen the file. web/sl_*.png.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8155"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/saveload_test.log");
let errs = 0;
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => { errs++; full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"); });
await page.goto("http://localhost:8155/blender-gui.html", { waitUntil: "load" });
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) break;
  await new Promise(r => setTimeout(r, 2000));
}
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1400) => new Promise(r => setTimeout(r, ms));
const shot = async (n) => {
  await page.locator("#canvas").screenshot({ path: `web/sl_${n}.png` });
  console.log(`step ${n}: errs=${errs}`);
};
await page.keyboard.press("Escape"); await settle();

// 1. select + move the cube along X by 2 (typed grab, deterministic)
await page.mouse.move(box.x + 700, box.y + 400); await settle(400);
await page.mouse.click(box.x + 700, box.y + 400); await settle();
await page.keyboard.press("g"); await settle(400);
await page.keyboard.type("x2"); await settle(400);
await page.keyboard.press("Enter"); await settle();
await shot("01_moved");
// 2. Ctrl+S -> file browser (fullscreen temp space)
await page.keyboard.down("Control"); await page.keyboard.press("s"); await page.keyboard.up("Control");
await settle(3000);
await shot("02_filebrowser");
// 3. accept default path (Enter in the browser = Save As execute)
await page.keyboard.press("Enter"); await settle(3000);
await shot("03_saved");
try {
  const fsdump = await page.evaluate(() => {
    const FS = globalThis.Module && Module.FS;
    if (!FS) return "noFS";
    const ls = (p) => { try { return FS.readdir(p).join(","); } catch (e) { return "ERR " + e; } };
    return "/home: " + ls("/home") + " | /home/velzie: " + ls("/home/velzie");
  });
  console.log("FSDUMP " + fsdump);
  const rn = await page.evaluate(() => {
    try { Module.FS.rename("/home/Untitled.blend@", "/home/renamed.blend"); return "rename OK"; }
    catch (e) { return "rename ERR " + (e && (e.errno + " " + e.message)); }
  });
  console.log("RENAME " + rn);
  const st = await page.evaluate(() => {
    const m = (p) => { try { return Module.FS.stat(p).mode.toString(8); } catch (e) { return "ERR"; } };
    return "/home mode=" + m("/home") + " file mode=" + m("/home/Untitled.blend@") + " root mode=" + m("/");
  });
  console.log("STAT " + st);
} catch (e) { console.log("FSDUMP fail " + e); }
// 4. move the cube again so reload visibly reverts it
await page.mouse.move(box.x + 700, box.y + 400); await settle(400);
await page.keyboard.press("g"); await settle(400);
await page.keyboard.type("z3"); await settle(400);
await page.keyboard.press("Enter"); await settle();
await shot("04_moved_again");
// 5. Ctrl+O -> file browser; the saved blend should be listed
await page.keyboard.down("Control"); await page.keyboard.press("o"); await page.keyboard.up("Control");
await settle(3000);
await shot("05_open_browser");
// 6. type the filename into the name field? Enter accepts highlighted; try
//    typing the full path via the filename field is fragile — the file browser
//    remembers the last saved file name in the field, so Enter should open it.
await page.mouse.move(box.x + 300, box.y + 101); await settle(400);
await page.mouse.dblclick(box.x + 300, box.y + 101); await settle(5000);
await shot("06_opened");
await browser.close(); srv.kill(); console.log("done errs=" + errs);
