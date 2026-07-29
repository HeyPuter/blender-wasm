// Experimentation sweep: tools/gizmos/menus/second-window behavior.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, "8121"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
let code = 1;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  const full = createWriteStream("/tmp/gui_explore_console.log");
  page.on("console", (m) => full.write(m.text() + "\n"));
  page.on("pageerror", (e) => full.write("PAGEERROR: " + e.message + "\n"));
  await page.goto("http://localhost:8121/blender-gui.html", { waitUntil: "load" });
  for (let i = 0; i < 70; i++) {
    const s = await page.evaluate(() => window.__BGUI__ || {});
    if (s.window) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  await new Promise(r => setTimeout(r, 4000));
  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  const shot = (n) => canvas.screenshot({ path: join(WEB, `exp_${n}.png`) });
  const click = (x, y) => page.mouse.click(box.x + x, box.y + y);
  const settle = (ms = 1300) => new Promise(r => setTimeout(r, ms));

  await page.keyboard.press("Escape"); await settle();   // splash

  // 1. Select the cube, then activate the Move tool from the toolbar.
  await click(654, 452); await settle();
  await click(28, 164); await settle(2500);              // Move tool icon (approx)
  await shot("01_move_tool");

  // 2. Try dragging the gizmo Z arrow (expected: picking broken, no move).
  await page.mouse.move(box.x + 654, box.y + 372);
  await settle(600);                                     // hover (highlight?)
  await shot("02_gizmo_hover");
  await page.mouse.down();
  await page.mouse.move(box.x + 654, box.y + 300, { steps: 10 });
  await page.mouse.up();
  await settle();
  await shot("03_gizmo_drag");

  // 3. File > New > General (reload the default scene).
  await click(30, 10); await settle();
  await shot("04_file_menu");
  await page.keyboard.press("Escape"); await settle(600);

  // 4. Edit menu > Preferences (wants a second window!).
  await click(75, 10); await settle();
  await shot("05_edit_menu");
  // "Preferences..." is the last item in the Edit menu.
  await click(110, 335); await settle(2500);
  await shot("06_preferences");
  await page.keyboard.press("Escape"); await settle(800);

  // 5. Rotate with R (modal, needs selection), confirm.
  await page.mouse.move(box.x + 654, box.y + 452);
  await click(654, 452); await settle(800);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 750, box.y + 380, { steps: 8 });
  await settle(400);
  await page.mouse.click(box.x + 750, box.y + 380);
  await settle();
  await shot("07_rotate_done");

  console.log("done");
  code = 0;
}
catch (e) { console.log("ERROR:", e.message); }
finally { await browser.close().catch(() => {}); srv.kill(); }
process.exit(code);
