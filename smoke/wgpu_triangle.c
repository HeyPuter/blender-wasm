// Proves WebGPU *rendering* works in wasm headless: render a colored triangle to
// an offscreen RGBA8 texture, copy it to a buffer, map+read (no JSPI), and hand
// the pixels to JS to putImageData onto a canvas. Same device-handoff + main-loop
// readback pattern as the compute probe. This is the path Blender's GHOST-less
// headless GPU verification will use.
#include <stdint.h>
#include <emscripten.h>
#include <webgpu/webgpu.h>

#define W 256
#define H 256
#define BYTES (W * H * 4)

static WGPUBuffer g_readback;
static int g_done = 0;

EM_JS(void, draw_result, (uintptr_t ptr, int w, int h), {
  const bytes = HEAPU8.subarray(ptr, ptr + w * h * 4);
  const cv = document.getElementById("cv");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(w, h);
  img.data.set(bytes);
  ctx.putImageData(img, 0, 0);
  window.__WGPU_WASM__ = { ok: true, w: w, h: h };
  document.title = "WGPU TRI OK";
  console.log("drew " + w + "x" + h + " triangle");
});
EM_JS(void, fail, (void), { window.__WGPU_WASM__ = { ok: false }; document.title = "WGPU TRI FAIL"; });

static WGPUStringView sv(const char *s) { WGPUStringView v = { s, WGPU_STRLEN }; return v; }

static void map_cb(WGPUMapAsyncStatus status, WGPUStringView msg, void *u1, void *u2) {
  if (status != WGPUMapAsyncStatus_Success) { fail(); g_done = 1; return; }
  const void *p = wgpuBufferGetConstMappedRange(g_readback, 0, BYTES);
  draw_result((uintptr_t)p, W, H);
  wgpuBufferUnmap(g_readback);
  g_done = 1;
}
static void tick(void) { if (g_done) emscripten_cancel_main_loop(); }

int main(void) {
  WGPUDevice device = emscripten_webgpu_get_device();
  if (!device) { fail(); return 1; }
  WGPUQueue queue = wgpuDeviceGetQueue(device);

  const char *wgsl =
    "struct VOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec3<f32> };\n"
    "@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {\n"
    "  var p = array<vec2<f32>,3>(vec2<f32>(0.0,0.7), vec2<f32>(-0.7,-0.6), vec2<f32>(0.7,-0.6));\n"
    "  var c = array<vec3<f32>,3>(vec3<f32>(1.0,0.25,0.15), vec3<f32>(0.15,1.0,0.3), vec3<f32>(0.2,0.35,1.0));\n"
    "  var o: VOut; o.pos = vec4<f32>(p[i],0.0,1.0); o.col = c[i]; return o;\n}\n"
    "@fragment fn fs(in: VOut) -> @location(0) vec4<f32> { return vec4<f32>(in.col,1.0); }\n";
  WGPUShaderSourceWGSL src = {0};
  src.chain.sType = WGPUSType_ShaderSourceWGSL;
  src.code = sv(wgsl);
  WGPUShaderModuleDescriptor smd = {0};
  smd.nextInChain = (WGPUChainedStruct *)&src;
  WGPUShaderModule mod = wgpuDeviceCreateShaderModule(device, &smd);

  WGPUTextureDescriptor td = {0};
  td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
  td.dimension = WGPUTextureDimension_2D;
  td.size = (WGPUExtent3D){ W, H, 1 };
  td.format = WGPUTextureFormat_RGBA8Unorm;
  td.mipLevelCount = 1;
  td.sampleCount = 1;
  WGPUTexture tex = wgpuDeviceCreateTexture(device, &td);
  WGPUTextureView view = wgpuTextureCreateView(tex, NULL);

  WGPUColorTargetState target = {0};
  target.format = WGPUTextureFormat_RGBA8Unorm;
  target.writeMask = WGPUColorWriteMask_All;
  WGPUFragmentState fs = {0};
  fs.module = mod; fs.entryPoint = sv("fs"); fs.targetCount = 1; fs.targets = &target;

  WGPURenderPipelineDescriptor rpd = {0};
  rpd.vertex.module = mod; rpd.vertex.entryPoint = sv("vs");
  rpd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
  rpd.multisample.count = 1; rpd.multisample.mask = 0xFFFFFFFFu;
  rpd.fragment = &fs;
  WGPURenderPipeline pipe = wgpuDeviceCreateRenderPipeline(device, &rpd);

  WGPUBufferDescriptor rbd = {0};
  rbd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
  rbd.size = BYTES;
  g_readback = wgpuDeviceCreateBuffer(device, &rbd);

  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
  WGPURenderPassColorAttachment ca = {0};
  ca.view = view;
  ca.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;  // required sentinel for non-3D targets
  ca.loadOp = WGPULoadOp_Clear;
  ca.storeOp = WGPUStoreOp_Store;
  ca.clearValue = (WGPUColor){ 0.10, 0.10, 0.13, 1.0 };
  WGPURenderPassDescriptor rp = {0};
  rp.colorAttachmentCount = 1; rp.colorAttachments = &ca;
  WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
  wgpuRenderPassEncoderSetPipeline(pass, pipe);
  wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
  wgpuRenderPassEncoderEnd(pass);

  WGPUTexelCopyTextureInfo srcCopy = {0};
  srcCopy.texture = tex;
  WGPUTexelCopyBufferInfo dstCopy = {0};
  dstCopy.buffer = g_readback;
  dstCopy.layout.bytesPerRow = W * 4;
  dstCopy.layout.rowsPerImage = H;
  WGPUExtent3D ext = { W, H, 1 };
  wgpuCommandEncoderCopyTextureToBuffer(enc, &srcCopy, &dstCopy, &ext);

  WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
  wgpuQueueSubmit(queue, 1, &cmd);

  WGPUBufferMapCallbackInfo ci = {0};
  ci.mode = WGPUCallbackMode_AllowSpontaneous;
  ci.callback = map_cb;
  wgpuBufferMapAsync(g_readback, WGPUMapMode_Read, 0, BYTES, ci);

  emscripten_set_main_loop(tick, 0, 0);
  return 0;
}
