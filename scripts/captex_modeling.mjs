// Boot the GUI, dismiss the splash, then map the deferred texture capture
// (WGPU_CAP_TEX_SHADER/WGPU_CAP_TEX_UNIT env → webgpu_batch.cc debug hook) and
// save it as web/captex_modeling.png. Usage:
//   CAP_SHADER=OCIO_Display CAP_UNIT=0 node scripts/gui_captex.mjs
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8161;
const chromeDir = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const WAIT_S = parseInt(process.env.GUI_WAIT || "150", 10);
const CAP_SHADER = process.env.CAP_SHADER || "OCIO_Display";
const CAP_UNIT = process.env.CAP_UNIT || "0";

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
  await ctx.addInitScript(`window.__CAPENV = { WGPU_CAP_TEX_SHADER: ${JSON.stringify(CAP_SHADER)}, WGPU_CAP_TEX_UNIT: ${JSON.stringify(CAP_UNIT)}, ...${JSON.stringify(extraEnv)} };`);
  const page = await ctx.newPage();
  const full = createWriteStream("/tmp/gui_captex_console.log");
  page.on("console", (m) => {
    const t = m.text();
    full.write(t + "\n");
    if (/WGPU_CAPTEX|WGPU_CAPTURE|ABORT/.test(t)) { console.log("  ·", t.slice(0, 180)); }
  });

  await page.goto(`http://localhost:${PORT}/blender-gui.html`, { waitUntil: "load", timeout: 60000 });
  const deadline = Date.now() + WAIT_S * 1000;
  let state = {};
  while (Date.now() < deadline) {
    state = await page.evaluate(() => window.__BGUI__ || {});
    if (state.window) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("state:", JSON.stringify(state));
  await new Promise((r) => setTimeout(r, 4000));

  // Dismiss the splash so the viewport redraws unobscured, wait a few frames.
  const box = await page.locator("#canvas").boundingBox();
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 1000));
  // Switch to the Modeling workspace (orange-fill outline bug repro).
  await page.mouse.move(box.x + 600, box.y + 400);
  await new Promise((r) => setTimeout(r, 500));
  await page.keyboard.down("Control");
  await page.keyboard.press("PageDown");
  await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 4000));
  // Nudge the mouse over the viewport to trigger a redraw (fresh capture).
  await page.mouse.move(box.x + 600, box.y + 400);
  await page.mouse.wheel(0, -1);   // tiny zoom → tags viewport for redraw
  await new Promise((r) => setTimeout(r, 3000));
  await page.locator("#canvas").screenshot({ path: "web/captex_screen.png" });

  const res = await page.evaluate(async () => {
    const M = window.Module;
    if (!M || typeof M._wgpu_capture_map !== "function") { return { err: "no capture exports" }; }
    const w = M._wgpu_capture_w(), h = M._wgpu_capture_h(), bpr = M._wgpu_capture_bpr(), bpp = M._wgpu_capture_bpp();
    if (w === 0 || h === 0) { return { err: "no capture recorded" }; }
    M._wgpu_capture_map();
    for (let i = 0; i < 300; i++) {
      if (M._wgpu_capture_ready() !== 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (M._wgpu_capture_ready() !== 1) { return { err: "map not ready: " + M._wgpu_capture_ready(), w, h }; }
    const ptr = M._wgpu_capture_ptr();
    const raw = M.HEAPU8.slice(ptr, ptr + bpr * h);
    if (bpp === 2) {
      /* R16Uint id buffer: histogram + scanline runs. */
      const dv16 = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const hist = new Map();
      for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
        const v = dv16.getUint16(y * bpr + x * 2, true);
        hist.set(v, (hist.get(v) || 0) + 1);
      }
      const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      const runs = [];
      const y = Math.floor(h * 0.5);
      let prev = -1, start = 0;
      for (let x = 0; x < w; x++) {
        const v = dv16.getUint16(y * bpr + x * 2, true);
        if (v !== prev) { if (prev !== -1) runs.push(prev + "x" + (x - start)); prev = v; start = x; }
      }
      runs.push(prev + "x" + (w - start));
      return { w, h, bpp, idhist: top, scanline: runs.slice(0, 40).join(" ") };
    }
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const half = (u) => {
      const s = (u & 0x8000) >> 15, e = (u & 0x7c00) >> 10, f = u & 0x03ff;
      let v; if (e === 0) v = f / 1024 * Math.pow(2, -14); else if (e === 31) v = f ? NaN : Infinity; else v = (1 + f / 1024) * Math.pow(2, e - 15);
      return s ? -v : v;
    };
    const out = new Uint8ClampedArray(w * h * 4);
    let nonzero = 0, alphaSum = 0;
    const enc = (c) => Math.max(0, Math.min(1, Math.pow(Math.max(c, 0), 1 / 2.2))) * 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = y * bpr + x * bpp;
      let r, g, b, a;
      if (bpp === 8) { r = half(dv.getUint16(o, true)); g = half(dv.getUint16(o + 2, true)); b = half(dv.getUint16(o + 4, true)); a = half(dv.getUint16(o + 6, true)); }
      else if (bpp === 16) { r = dv.getFloat32(o, true); g = dv.getFloat32(o + 4, true); b = dv.getFloat32(o + 8, true); a = dv.getFloat32(o + 12, true); }
      else { r = raw[o] / 255; g = raw[o + 1] / 255; b = raw[o + 2] / 255; a = raw[o + 3] / 255; }
      const di = (y * w + x) * 4;
      out[di] = enc(r); out[di + 1] = enc(g); out[di + 2] = enc(b); out[di + 3] = 255;
      if (r || g || b) nonzero++;
      alphaSum += a;
    }
    const cx = (h >> 1) * bpr + (w >> 1) * bpp;
    const center = bpp === 8 ? [0, 2, 4, 6].map((k) => half(dv.getUint16(cx + k, true)))
                : bpp === 16 ? [0, 4, 8, 12].map((k) => dv.getFloat32(cx + k, true))
                             : [0, 1, 2, 3].map((k) => raw[cx + k] / 255);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").putImageData(new ImageData(out, w, h), 0, 0);
    return { w, h, bpp, nonzero, total: w * h, center, alphaAvg: alphaSum / (w * h), png: cv.toDataURL("png") };
  });

  if (res.idhist) { console.log("IDHIST", JSON.stringify(res.idhist)); console.log("SCAN", res.scanline); }
  if (res.err) { console.log("CAPTURE FAIL:", res.err); }
  else {
    console.log(`CAPTURE ${res.w}x${res.h} bpp=${res.bpp} nonzero=${res.nonzero}/${res.total} center=${JSON.stringify(res.center)} alphaAvg=${res.alphaAvg.toFixed(3)}`);
    writeFileSync(join(WEB, "captex_modeling.png"), Buffer.from(res.png.replace(/^data:image\/png;base64,/, ""), "base64"));
    console.log("saved web/captex_modeling.png");
    code = 0;
  }
}
catch (e) { console.log("ERROR:", e.message); }
finally {
  await browser.close().catch(() => {});
  srv.kill();
}
process.exit(code);
