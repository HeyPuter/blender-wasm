// Run full Blender (wasm) under Node with WebGPU provided by @kmamal/gpu (Dawn)
// backed by lavapipe (Mesa software Vulkan). Unlike chromium+SwiftShader, this
// exposes the device's real limits (8 storage tex/stage, 1024 workgroup), which
// EEVEE-Next's compute passes need. Runs an EEVEE render of the default scene
// (bright red world) and reads back the captured framebuffer.
//   VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json node run_blender.cjs
const path = require("node:path");
const fs = require("node:fs");
const gpu = require("@kmamal/gpu");

const PYEXPR =
  "import bpy;print('PYSTART');" +
  "s=bpy.context.scene;s.render.resolution_x=64;s.render.resolution_y=64;" +
  "print('WENGINE',s.render.engine);" +
  "import traceback\n" +
  "try:\n" +
  " w=bpy.context.scene.world; w.use_nodes=True\n" +
  " bg=w.node_tree.nodes.get('Background')\n" +
  " bg.inputs[0].default_value=(1.0,0.0,0.0,1.0); bg.inputs[1].default_value=3.0\n" +
  " print('WORLD set red')\n" +
  "except Exception as e:\n traceback.print_exc()\n" +
  "try:\n bpy.ops.render.render(write_still=False)\nexcept Exception as e:\n traceback.print_exc()\n" +
  "print('PYDONE')\n" +
  "import sys; sys.stderr.write('RENDER_DONE_MARK\\n'); sys.stderr.flush()";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navGpu = gpu.create([]);
  globalThis.navigator = globalThis.navigator || {};
  try {
    Object.defineProperty(globalThis.navigator, "gpu", { value: navGpu, configurable: true });
  } catch { globalThis.navigator.gpu = navGpu; }
  // CPython's _Py_emscripten_runtime reads navigator.userAgent (undefined on our
  // bare navigator → crash). Provide a string.
  if (!globalThis.navigator.userAgent) {
    try {
      Object.defineProperty(globalThis.navigator, "userAgent",
        { value: "Node.js " + process.version, configurable: true });
    } catch { globalThis.navigator.userAgent = "Node.js " + process.version; }
  }

  const adapter = await navGpu.requestAdapter();
  if (!adapter) { console.log("NO ADAPTER"); process.exit(1); }
  console.log("adapter:", JSON.stringify(adapter.info?.description || adapter.info || {}));
  // Request the adapter's real (high) limits so EEVEE compute pipelines validate.
  const wantLimits = [
    "maxStorageTexturesPerShaderStage", "maxStorageBuffersPerShaderStage",
    "maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage",
    "maxUniformBuffersPerShaderStage", "maxComputeWorkgroupSizeX",
    "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ",
    "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupStorageSize",
    "maxComputeWorkgroupsPerDimension", "maxStorageBufferBindingSize",
    "maxUniformBufferBindingSize", "maxBufferSize", "maxBindingsPerBindGroup",
  ];
  const requiredLimits = {};
  for (const k of wantLimits) {
    const v = adapter.limits[k];
    if (v !== undefined) requiredLimits[k] = v;
  }
  console.log("requesting storage-tex/stage=" + requiredLimits.maxStorageTexturesPerShaderStage +
              " wgX=" + requiredLimits.maxComputeWorkgroupSizeX);
  const device = await adapter.requestDevice({ requiredLimits });
  device.addEventListener?.("uncapturederror", (e) => console.log("[gpuerr]", e.error?.message?.slice(0, 160)));

  let quit = false;
  const fullFd = fs.openSync(path.join(__dirname, "blender_full.log"), "w");
  const onLine = (t) => {
    t = String(t);
    try { fs.writeSync(fullFd, t + "\n"); } catch {}  // synchronous → visible even if render hangs
    if (/WENGINE|PYSTART|PYDONE|Blender quit|WORLD set|WGPU_CAPTURE|WGPU_WORLDDRAW|exceeds the maximum|does not support storage|RENDER_DONE_MARK/.test(t)) {
      console.log("  >", t.slice(0, 150));
    }
    if (t.includes("RENDER_DONE_MARK") || t.includes("PYDONE")) quit = true;
  };

  let M; // emscripten Module (set by the factory)
  const config = {
    thisProgram: "/blender", // so Blender resolves scripts at /5.3/scripts (mounted)
    arguments: ["--factory-startup", "-b", "--python-expr", PYEXPR],
    preinitializedWebGPUDevice: device,
    locateFile: (p) => path.join(__dirname, p),
    print: (t) => onLine(t),
    printErr: (t) => onLine(t),
    preRun: [function (Mod) {
      try {
        Mod.ENV.BLENDER_SYSTEM_SCRIPTS = "/5.3/scripts";
        Mod.ENV.BLENDER_SYSTEM_DATAFILES = "/5.3/datafiles";
        console.log("preRun: ENV set");
      } catch (e) { console.log("preRun ENV note:", e.message); }
    }],
    onAbort: (w) => console.log("ABORT:", w),
  };

  console.log("loading blender_node.js (MODULARIZE) ... lavapipe software render is slow");
  const createBlenderModule = require(path.join(__dirname, "blender_node.js"));
  // The factory resolves once the runtime is initialized (FS mounted, before main
  // — but callMain runs from within; we await the module then poll for the marker).
  const modPromise = createBlenderModule(config);
  // Don't block on the factory promise (callMain may run synchronously inside);
  // poll for completion marker. Grab M as soon as available.
  modPromise.then((m) => { M = m; }).catch((e) => console.log("factory err:", e.message));

  for (let i = 0; i < 4000 && !quit; i++) await sleep(200);
  console.log(quit ? "render done (marker seen)." : "render did not signal done (timeout).");
  if (!M) { try { M = await modPromise; } catch {} }
  await sleep(500);
  if (!M) { console.log("no Module"); process.exit(2); }
  try {
    console.log("FS /5.3:", M.FS.readdir("/5.3"));
  } catch (e) { console.log("FS /5.3 err:", e.message); }
  console.log("Module._wgpu_capture_map typeof:", typeof M._wgpu_capture_map,
              " keys w/ wgpu:", Object.keys(M).filter((k) => k.includes("wgpu")).slice(0, 8));
  if (typeof M._wgpu_capture_map !== "function" && typeof M.ccall === "function") {
    // Some builds expose only via ccall.
    M._wgpu_capture_map = () => M.ccall("wgpu_capture_map", null, [], []);
    M._wgpu_capture_w = () => M.ccall("wgpu_capture_w", "number", [], []);
    M._wgpu_capture_h = () => M.ccall("wgpu_capture_h", "number", [], []);
    M._wgpu_capture_bpr = () => M.ccall("wgpu_capture_bpr", "number", [], []);
    M._wgpu_capture_bpp = () => M.ccall("wgpu_capture_bpp", "number", [], []);
    M._wgpu_capture_ready = () => M.ccall("wgpu_capture_ready", "number", [], []);
    M._wgpu_capture_ptr = () => M.ccall("wgpu_capture_ptr", "number", [], []);
  }
  if (typeof M._wgpu_capture_map !== "function") {
    console.log("capture exports unavailable");
    process.exit(2);
  }
  const w = M._wgpu_capture_w(), h = M._wgpu_capture_h(), bpr = M._wgpu_capture_bpr(), bpp = M._wgpu_capture_bpp();
  console.log(`capture meta: ${w}x${h} bpr=${bpr} bpp=${bpp}`);
  if (w === 0) { console.log("no capture recorded"); process.exit(3); }
  M._wgpu_capture_map();
  for (let i = 0; i < 300; i++) { if (M._wgpu_capture_ready() !== 0) break; await sleep(20); }
  const ready = M._wgpu_capture_ready();
  if (ready !== 1) { console.log("map not ready, status=" + ready); process.exit(4); }

  const ptr = M._wgpu_capture_ptr();
  const heap = M.HEAPU8;
  const size = bpr * h;
  const raw = Buffer.from(heap.buffer, ptr, size);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const half = (u) => {
    const s = (u & 0x8000) >> 15, e = (u & 0x7c00) >> 10, f = u & 0x03ff;
    let v; if (e === 0) v = f / 1024 * 2 ** -14; else if (e === 31) v = f ? NaN : Infinity; else v = (1 + f / 1024) * 2 ** (e - 15);
    return s ? -v : v;
  };
  let nonzero = 0, mn = 1e9, mx = -1e9;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * bpr + x * bpp;
    let r, g, b;
    if (bpp === 8) { r = half(dv.getUint16(o, true)); g = half(dv.getUint16(o + 2, true)); b = half(dv.getUint16(o + 4, true)); }
    else { r = raw[o] / 255; g = raw[o + 1] / 255; b = raw[o + 2] / 255; }
    if (r || g || b) nonzero++;
    mn = Math.min(mn, r, g, b); mx = Math.max(mx, r, g, b);
  }
  const cx = (h >> 1) * bpr + (w >> 1) * bpp;
  const center = bpp === 8
    ? [half(dv.getUint16(cx, true)), half(dv.getUint16(cx + 2, true)), half(dv.getUint16(cx + 4, true))]
    : [raw[cx], raw[cx + 1], raw[cx + 2]];
  console.log(`CAPTURE ${w}x${h} nonzero=${nonzero}/${w * h} center=${JSON.stringify(center)} range=[${mn.toFixed(3)},${mx.toFixed(3)}]`);

  // Write a PPM (simple, no deps) tonemapped to 8-bit.
  const ppm = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * bpr + x * bpp; const di = (y * w + x) * 3;
    const get = (off) => bpp === 8 ? half(dv.getUint16(o + off * 2, true)) : raw[o + off] / 255;
    const enc = (c) => Math.max(0, Math.min(1, (c < 0 ? 0 : c) ** (1 / 2.2))) * 255 | 0;
    ppm[di] = enc(get(0)); ppm[di + 1] = enc(get(1)); ppm[di + 2] = enc(get(2));
  }
  const out = path.join(__dirname, "eevee_node_capture.ppm");
  fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), ppm]));
  console.log("saved", out);
  if (nonzero > 0) console.log("EEVEE PIXELS via lavapipe/Dawn/node — non-zero output!");
  process.exit(nonzero > 0 ? 0 : 5);
})().catch((e) => { console.log("HARNESS ERROR:", e.stack || e.message); process.exit(9); });
