// Capture the pixels EEVEE rendered through the WebGPU backend. Loads Blender in
// chromium+SwiftShader with a real WebGPU device, runs an EEVEE render (which
// copies its "combined" framebuffer color into a persistent readback buffer via
// the backend's capture hook), then — AFTER "Blender quit", when the browser
// event loop is free again — maps that buffer from JS and reads the pixels.
// Saves web/eevee_capture.png and prints center-pixel + non-zero stats.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8097;
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: `${chromeDir}/chrome`,
  env: { ...process.env, VK_ICD_FILENAMES: `${chromeDir}/vk_swiftshader_icd.json` },
  args: ["--headless=new", "--no-sandbox", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu",
         "--enable-features=Vulkan", "--disable-vulkan-surface"],
});
let code = 1;
try {
  const page = await (await browser.newContext()).newPage();
  let quit = null;
  const quitP = new Promise((res) => { quit = res; });
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("WGPU_CAPTURE") || t.includes("WGPU_BG ") || t.includes("WGPU_WORLDDRAW") || t.includes("WORLD set")) {
      console.log("[b]", t.slice(0, 170));
    }
    if (t.includes("Blender quit")) { quit(); }
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 160)));

  await page.goto(`http://localhost:${PORT}/blender-webgpu.html`, { waitUntil: "load", timeout: 60000 });
  console.log("waiting for render to finish (Blender quit)...");
  await Promise.race([quitP, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 260000))]);
  console.log("Blender quit — render done. Mapping capture buffer...");
  await new Promise((r) => setTimeout(r, 1500));

  const res = await page.evaluate(async () => {
    const M = window.Module;
    if (!M || typeof M._wgpu_capture_map !== "function") {
      return { err: "capture exports unavailable: " + Object.keys(M || {}).filter(k => k.startsWith("_wgpu")).join(",") };
    }
    const w = M._wgpu_capture_w(), h = M._wgpu_capture_h(), bpr = M._wgpu_capture_bpr(), bpp = M._wgpu_capture_bpp();
    if (w === 0 || h === 0) { return { err: "no capture recorded (w/h=0)" }; }
    M._wgpu_capture_map();
    // Let the browser event loop process the async map callback.
    for (let i = 0; i < 200; i++) {
      const r = M._wgpu_capture_ready();
      if (r !== 0) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const ready = M._wgpu_capture_ready();
    if (ready !== 1) { return { err: "map not ready, status=" + ready, w, h, bpr, bpp }; }
    const ptr = M._wgpu_capture_ptr();
    const heap = M.HEAPU8;
    const size = bpr * h;
    const raw = heap.slice(ptr, ptr + size);

    // Convert to RGBA8 for a PNG (handle RGBA8=4bpp and RGBA16F=8bpp).
    const half = (u16) => {
      const s = (u16 & 0x8000) >> 15, e = (u16 & 0x7c00) >> 10, f = u16 & 0x03ff;
      let v;
      if (e === 0) v = f / 1024 * Math.pow(2, -14);
      else if (e === 31) v = f ? NaN : Infinity;
      else v = (1 + f / 1024) * Math.pow(2, e - 15);
      return s ? -v : v;
    };
    const out = new Uint8ClampedArray(w * h * 4);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let nonzero = 0;
    const stat = { min: 1e9, max: -1e9 };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = y * bpr + x * bpp;
        let r, g, b, a;
        if (bpp === 8) {
          r = half(dv.getUint16(o, true)); g = half(dv.getUint16(o + 2, true));
          b = half(dv.getUint16(o + 4, true)); a = half(dv.getUint16(o + 6, true));
        } else {
          r = raw[o] / 255; g = raw[o + 1] / 255; b = raw[o + 2] / 255; a = raw[o + 3] / 255;
        }
        const di = (y * w + x) * 4;
        // simple gamma for display
        const enc = (c) => Math.max(0, Math.min(1, Math.pow(Math.max(c, 0), 1 / 2.2))) * 255;
        out[di] = enc(r); out[di + 1] = enc(g); out[di + 2] = enc(b); out[di + 3] = 255;
        if (r || g || b) nonzero++;
        stat.min = Math.min(stat.min, r, g, b); stat.max = Math.max(stat.max, r, g, b);
      }
    }
    // center pixel raw
    const cx = (h >> 1) * bpr + (w >> 1) * bpp;
    let center;
    if (bpp === 8) center = [half(dv.getUint16(cx, true)), half(dv.getUint16(cx + 2, true)), half(dv.getUint16(cx + 4, true)), half(dv.getUint16(cx + 6, true))];
    else center = [raw[cx], raw[cx + 1], raw[cx + 2], raw[cx + 3]];

    // PNG via canvas
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx2 = cv.getContext("2d");
    ctx2.putImageData(new ImageData(out, w, h), 0, 0);
    const url = cv.toDataURL("png");
    return { w, h, bpr, bpp, nonzero, total: w * h, center, min: stat.min, max: stat.max, png: url };
  });

  if (res.err) { console.log("CAPTURE FAIL:", res.err); }
  else {
    console.log(`CAPTURE: ${res.w}x${res.h} bpp=${res.bpp} nonzero=${res.nonzero}/${res.total} center=${JSON.stringify(res.center)} range=[${res.min.toFixed(4)},${res.max.toFixed(4)}]`);
    const b64 = res.png.replace(/^data:image\/png;base64,/, "");
    writeFileSync(join(WEB, "eevee_capture.png"), Buffer.from(b64, "base64"));
    console.log("saved web/eevee_capture.png");
    if (res.nonzero > 0) { console.log("EEVEE PIXELS CAPTURED — non-zero output rendered via WebGPU"); code = 0; }
    else { console.log("capture is all-zero (render produced no color in the combined buffer)"); }
  }
} catch (e) {
  console.log("RUNNER ERROR:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(code);
}
