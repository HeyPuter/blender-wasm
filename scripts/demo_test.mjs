// Release-demo E2E: vite preview -> setup screen extracts assets to OPFS ->
// Blender boots from /opfs -> save -> reload (no setup this time) -> file
// persists. Console → /tmp/demo_test.log, shots web/demo_*.png.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("npx", ["vite", "preview", "--port", "4180", "--strictPort"],
                  { cwd: "demo", stdio: "ignore" });
await new Promise(r => setTimeout(r, 2500));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const full = createWriteStream("/tmp/demo_test.log");
let errs = 0;
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => { errs++; full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"); });
const t0 = Date.now();
await page.goto("http://localhost:4180/", { waitUntil: "load" });
const boot = async (tag, timeoutS = 240) => {
  for (let i = 0; i < timeoutS; i++) {
    const s = await page.evaluate(() => window.__BGUI__ || {});
    if (s.window) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(tag + " BOOT TIMEOUT");
  return false;
};
console.log("first-visit boot ok=" + await boot("first") + " t=" + (Date.now() - t0) + "ms errs=" + errs);
await new Promise(r => setTimeout(r, 4000));
const box = await page.locator("#canvas").boundingBox();
const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));
await page.keyboard.press("Escape"); await settle();
await page.locator("#canvas").screenshot({ path: "web/demo_1_gui.png" });
const fsprobe = await page.evaluate(() => {
  const ls = (p) => { try { return Module.FS.readdir(p).slice(0, 12).join(","); } catch (e) { return "ERR " + e; } };
  return ["/opfs", "/opfs/assets", "/opfs/assets/5.3", "/opfs/assets/5.3/scripts"]
    .map((p) => p + " => " + ls(p)).join("\n");
});
console.log("FSPROBE\n" + fsprobe);

// move cube + save
await page.mouse.move(box.x + 700, box.y + 400); await settle(400);
await page.mouse.click(box.x + 700, box.y + 400); await settle();
await page.keyboard.press("g"); await settle(300);
await page.keyboard.type("x2"); await settle(300);
await page.keyboard.press("Enter"); await settle();
await page.keyboard.down("Control"); await page.keyboard.press("s"); await page.keyboard.up("Control");
await settle(3000);
await page.keyboard.press("Enter"); await settle(4000);
await page.locator("#canvas").screenshot({ path: "web/demo_2_saved.png" });

// reload: no setup, boot from OPFS, file persists
const t1 = Date.now();
await page.reload({ waitUntil: "load" });
console.log("second-visit boot ok=" + await boot("second") + " t=" + (Date.now() - t1) + "ms errs=" + errs);
await new Promise(r => setTimeout(r, 4000));
await page.keyboard.press("Escape"); await settle();
await page.mouse.move(box.x + 700, box.y + 400); await settle(400);
await page.keyboard.down("Control"); await page.keyboard.press("o"); await page.keyboard.up("Control");
await settle(3000);
await page.locator("#canvas").screenshot({ path: "web/demo_3_open.png" });
await page.mouse.move(box.x + 300, box.y + 101); await settle(400);
await page.mouse.dblclick(box.x + 300, box.y + 101); await settle(5000);
await page.locator("#canvas").screenshot({ path: "web/demo_4_opened.png" });
console.log("done errs=" + errs);
await browser.close(); srv.kill();
