// Full EEVEE render through the WebGPU backend in REAL Playwright on the REAL AMD
// GPU (not SwiftShader), reading the composited result back via DEFERRED capture.
//
// The render is driven by Python (bpy.ops.render.render). Blender's Film reads the
// composited "combined" texture via GPU_texture_read, which the WebGPU backend
// (WebGPUContext::read_color_sync) turns into a copyTextureToBuffer into a
// persistent buffer — no synchronous map (JSPI can't suspend through CPython's JS
// call trampoline). After the render returns and the browser event loop is free,
// we map that buffer from JS and save the pixels as a PNG.
//
// Real GPU access: this box runs Hyprland with an Xwayland server on DISPLAY=:0.
// chromium refuses Vulkan under wayland ozone, so use x11 ozone against Xwayland;
// WebGPU needs a secure context, so serve over http://localhost.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8109;
const chromeDir = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64`;

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: `${chromeDir}/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
});
let code = 1;
try {
  const page = await (await browser.newContext()).newPage();
  let quit = null;
  const quitP = new Promise((res) => { quit = res; });
  // Full console dump for debugging backend validation errors (stdout stays filtered).
  const full = createWriteStream("/tmp/eevee_console_full.log");
  page.on("console", (m) => {
    const t = m.text();
    full.write(t + "\n");
    if (/adapter|limits|WGPU_CAPTURE|WORLD set|WENGINE|RENDER|PYDONE|does not support|exceeds/i.test(t)) {
      console.log("[b]", t.slice(0, 170));
    }
    if (t.includes("Blender quit") || t.includes("PYDONE")) { quit(); }
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));

  await page.goto(`http://localhost:${PORT}/blender-webgpu.html`, { waitUntil: "load", timeout: 60000 });
  console.log("rendering (real GPU EEVEE), waiting for render to finish…");
  await Promise.race([quitP, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 260000))]);
  console.log("render done — mapping deferred capture buffer…");
  await new Promise((r) => setTimeout(r, 800));

  const res = await page.evaluate(async () => {
    const M = window.Module;
    if (!M || typeof M._wgpu_capture_map !== "function") {
      return { err: "capture exports unavailable: " + Object.keys(M || {}).filter(k => k.startsWith("_wgpu")).join(",") };
    }
    const w = M._wgpu_capture_w(), h = M._wgpu_capture_h(), bpr = M._wgpu_capture_bpr(), bpp = M._wgpu_capture_bpp();
    if (w === 0 || h === 0) { return { err: "no capture recorded (w/h=0)" }; }
    M._wgpu_capture_map();
    for (let i = 0; i < 300; i++) {
      if (M._wgpu_capture_ready() !== 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const ready = M._wgpu_capture_ready();
    if (ready !== 1) { return { err: "map not ready, status=" + ready, w, h }; }
    const ptr = M._wgpu_capture_ptr();
    const size = bpr * h;
    const raw = M.HEAPU8.slice(ptr, ptr + size);
    if (h === 1) {
      // Raw buffer dump mode (debug_capture_buffer): report the first words.
      const u32 = new Uint32Array(raw.buffer, raw.byteOffset, Math.min(64, size >> 2));
      return { rawWords: Array.from(u32), w, h };
    }
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const half = (u) => {
      const s = (u & 0x8000) >> 15, e = (u & 0x7c00) >> 10, f = u & 0x03ff;
      let v; if (e === 0) v = f / 1024 * Math.pow(2, -14); else if (e === 31) v = f ? NaN : Infinity; else v = (1 + f / 1024) * Math.pow(2, e - 15);
      return s ? -v : v;
    };
    const out = new Uint8ClampedArray(w * h * 4);
    let nonzero = 0; const stat = { min: 1e9, max: -1e9 };
    const enc = (c) => Math.max(0, Math.min(1, Math.pow(Math.max(c, 0), 1 / 2.2))) * 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = y * bpr + x * bpp;
      let r, g, b, a;
      if (bpp === 8) { r = half(dv.getUint16(o, true)); g = half(dv.getUint16(o + 2, true)); b = half(dv.getUint16(o + 4, true)); a = half(dv.getUint16(o + 6, true)); }
      else { r = raw[o] / 255; g = raw[o + 1] / 255; b = raw[o + 2] / 255; a = raw[o + 3] / 255; }
      const di = (y * w + x) * 4;
      out[di] = enc(r); out[di + 1] = enc(g); out[di + 2] = enc(b); out[di + 3] = 255;
      if (r || g || b) nonzero++;
      if (isFinite(r)) { stat.min = Math.min(stat.min, r, g, b); stat.max = Math.max(stat.max, r, g, b); }
    }
    const cx = (h >> 1) * bpr + (w >> 1) * bpp;
    const center = bpp === 8 ? [0, 2, 4, 6].map((k) => half(dv.getUint16(cx + k, true)))
                             : [0, 1, 2, 3].map((k) => raw[cx + k]);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").putImageData(new ImageData(out, w, h), 0, 0);
    return { w, h, bpp, nonzero, total: w * h, center, min: stat.min, max: stat.max, png: cv.toDataURL("png") };
  });

  if (res.err) { console.log("CAPTURE FAIL:", res.err); }
  else if (res.rawWords) { console.log("RAW BUFFER DUMP:", JSON.stringify(res.rawWords)); code = 0; }
  else {
    console.log(`CAPTURE: ${res.w}x${res.h} bpp=${res.bpp} nonzero=${res.nonzero}/${res.total} center=${JSON.stringify(res.center)} range=[${res.min.toFixed(4)},${res.max.toFixed(4)}]`);
    writeFileSync(join(WEB, "eevee_gpu_render.png"), Buffer.from(res.png.replace(/^data:image\/png;base64,/, ""), "base64"));
    console.log("saved web/eevee_gpu_render.png");
    if (res.nonzero > 0) { console.log("EEVEE RENDER OK — non-zero pixels captured via WebGPU on the real GPU in Playwright"); code = 0; }
    else { console.log("capture is all-zero"); }
  }
} catch (e) {
  console.log("RUNNER ERROR:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(code);
}
