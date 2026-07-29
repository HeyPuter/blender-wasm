// WGSL cache effectiveness: boot+orbit (cold), reload, boot+orbit (warm).
// Compares WGPU_SHADER_MS (translation stall) counts. → /tmp/wgslcache_test.log
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";
const srv = spawn("node", ["scripts/serve.mjs", "web", "8175"], { stdio: "ignore" });
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
const full = createWriteStream("/tmp/wgslcache_test.log");
let shaderMs = 0, translateMs = 0;
page.on("console", (m) => {
  const t = m.text();
  full.write(t + "\n");
  const mm = t.match(/WGPU_SHADER_MS '[^']+' (\d+)ms/);
  if (mm) { shaderMs++; translateMs += parseInt(mm[1], 10); }
});
const boot = async () => {
  const t0 = Date.now();
  for (let i = 0; i < 70; i++) {
    const s = await page.evaluate(() => window.__BGUI__ || {});
    if (s.window) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return Date.now() - t0;
};
const orbit = async () => {
  const box = await page.locator("#canvas").boundingBox();
  await page.keyboard.press("Escape");
  await new Promise(r => setTimeout(r, 1500));
  await page.mouse.move(box.x + 700, box.y + 400);
  await page.mouse.down({ button: "middle" });
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(box.x + 700 + i * 6, box.y + 400 + i * 2);
    await new Promise(r => setTimeout(r, 30));
  }
  await page.mouse.up({ button: "middle" });
  // click-select + grab to trigger select/overlay variants
  await page.mouse.click(box.x + 760, box.y + 430);
  await new Promise(r => setTimeout(r, 1200));
  await page.keyboard.press("g");
  await page.mouse.move(box.x + 800, box.y + 400, { steps: 8 });
  await page.keyboard.press("Enter");
  await new Promise(r => setTimeout(r, 1500));
};

await page.goto("http://localhost:8175/blender-gui.html", { waitUntil: "load" });
const coldBoot = await boot();
await new Promise(r => setTimeout(r, 4000));
await orbit();
const coldN = shaderMs, coldMs = translateMs;
console.log(`COLD boot=${coldBoot}ms translations>30ms: n=${coldN} total=${coldMs}ms`);
await new Promise(r => setTimeout(r, 3000)); // let IDB puts flush

shaderMs = 0; translateMs = 0;
await page.reload({ waitUntil: "load" });
const warmBoot = await boot();
await new Promise(r => setTimeout(r, 4000));
await orbit();
console.log(`WARM boot=${warmBoot}ms translations>30ms: n=${shaderMs} total=${translateMs}ms`);
await browser.close(); srv.kill(); console.log("done");
