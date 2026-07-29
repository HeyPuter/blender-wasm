// Boot the GUI, dismiss splash, then poke several UI areas, screenshotting
// after each: web/poke_<name>.png. Console → /tmp/gui_poke_console.log.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8113;
const chromeDir = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const WAIT_S = parseInt(process.env.GUI_WAIT || "150", 10);

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: `${chromeDir}/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-experimental-webassembly-jspi", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});

let code = 1;
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const extraEnv = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("WGPU_")) extraEnv[k] = process.env[k];
  }
  await ctx.addInitScript(`window.__CAPENV = ${JSON.stringify(extraEnv)};`);
  const page = await ctx.newPage();
  const full = createWriteStream("/tmp/gui_poke_console.log");
  page.on("console", (m) => full.write(m.text() + "\n"));

  await page.goto(`http://localhost:${PORT}/blender-gui.html`, { waitUntil: "load", timeout: 60000 });
  const deadline = Date.now() + WAIT_S * 1000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.__BGUI__ || {});
    if (state.window) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await new Promise((r) => setTimeout(r, 4000));

  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  let stepT = Date.now();
  const shot = async (name) => {
    await canvas.screenshot({ path: join(WEB, `poke_${name}.png`) });
    console.log(`step ${name}: ${Date.now() - stepT}ms`);
    stepT = Date.now();
  };
  const click = (x, y) => page.mouse.click(box.x + x, box.y + y);
  const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

  await shot("00_splash");                      // splash still up
  await click(768, 620); await settle();        // dismiss splash
  await shot("00_start");

  await click(1400, 90); await settle();        // outliner body
  await shot("01_outliner_click");

  await click(1400, 450); await settle();       // properties body
  await shot("02_props_click");

  await click(30, 10); await settle();          // File menu (topbar)
  await shot("03_file_menu");
  await page.keyboard.press("Escape"); await settle(600);

  await click(268, 65); await settle();         // Add menu (viewport header)
  await shot("04_add_menu");
  await page.keyboard.press("Escape"); await settle(600);

  // Orbit: middle-drag in the viewport.
  await page.mouse.move(box.x + 600, box.y + 450);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 700, box.y + 400, { steps: 10 });
  await page.mouse.up({ button: "middle" });
  await settle(1500);
  await shot("05_orbit");

  // Select the cube (left click on it) — expect selection outline change.
  await click(654, 452); await settle();
  await shot("06_cube_click");

  // Tab into edit mode (cursor must hover the viewport) — expect wireframe +
  // vertices; exercises the point shaders.
  await page.mouse.move(box.x + 654, box.y + 452);
  await page.keyboard.press("Tab");
  await settle(2500);
  await shot("07_edit_mode");
  await page.keyboard.press("Tab");
  await settle(1000);

  // Grab-move the cube: G, move mouse, click to confirm.
  await page.mouse.move(box.x + 654, box.y + 452);
  await page.keyboard.press("g");
  await settle(500);
  await page.mouse.move(box.x + 800, box.y + 380, { steps: 12 });
  await settle(500);
  await shot("08_grab_preview");
  await page.mouse.click(box.x + 800, box.y + 380);
  await settle(1200);
  await shot("09_grab_done");

  // Shift+A add menu over the viewport.
  await page.keyboard.down("Shift");
  await page.keyboard.press("a");
  await page.keyboard.up("Shift");
  await settle(1200);
  await shot("10_add_menu");
  // Add > Mesh > (submenu) — hover "Mesh".
  await page.mouse.move(box.x + 650, box.y + 300, { steps: 5 });
  await settle(1000);
  await shot("11_add_mesh_sub");
  await page.keyboard.press("Escape");
  await settle(500);

  // Resize the browser viewport — exercises canvas/backbuffer/surface resize.
  await page.setViewportSize({ width: 1250, height: 750 });
  await settle(3000);
  await canvas.screenshot({ path: join(WEB, "poke_12_resized.png") });

  console.log("done");
  code = 0;
}
catch (e) { console.log("ERROR:", e.message); }
finally {
  await browser.close().catch(() => {});
  srv.kill();
}
process.exit(code);
