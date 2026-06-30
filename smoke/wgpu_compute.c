// Proves a WASM module can drive WebGPU compute in this browser WITHOUT JSPI:
// the device is created in JS and handed over via emscripten_webgpu_get_device();
// readback uses an async map callback pumped by the normal event loop.
#include <stdint.h>
#include <emscripten.h>
#include <webgpu/webgpu.h>

static WGPUBuffer g_readback;
static int g_done = 0;

EM_JS(void, report, (int ok, int a, int b, int c, int d), {
  window.__WGPU_WASM__ = { ok: !!ok, result: [a, b, c, d] };
  document.title = ok ? "WGPU WASM OK" : "WGPU WASM FAIL";
  console.log("wasm webgpu compute result: [" + a + "," + b + "," + c + "," + d + "]");
});

static WGPUStringView sv(const char *s) { WGPUStringView v = { s, WGPU_STRLEN }; return v; }

static void map_cb(WGPUMapAsyncStatus status, WGPUStringView msg, void *u1, void *u2) {
  if (status != WGPUMapAsyncStatus_Success) { report(0, 0, 0, 0, 0); g_done = 1; return; }
  const uint32_t *p = (const uint32_t *)wgpuBufferGetConstMappedRange(g_readback, 0, 16);
  report(1, p[0], p[1], p[2], p[3]);
  wgpuBufferUnmap(g_readback);
  g_done = 1;
}
static void tick(void) { if (g_done) emscripten_cancel_main_loop(); }

int main(void) {
  WGPUDevice device = emscripten_webgpu_get_device();
  if (!device) { report(0, 0, 0, 0, 0); return 1; }
  WGPUQueue queue = wgpuDeviceGetQueue(device);

  const char *wgsl =
    "@group(0) @binding(0) var<storage, read_write> data: array<u32>;\n"
    "@compute @workgroup_size(4) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n"
    "  data[gid.x] = data[gid.x] * 2u;\n}\n";
  WGPUShaderSourceWGSL src = {0};
  src.chain.sType = WGPUSType_ShaderSourceWGSL;
  src.code = sv(wgsl);
  WGPUShaderModuleDescriptor smd = {0};
  smd.nextInChain = (WGPUChainedStruct *)&src;
  WGPUShaderModule mod = wgpuDeviceCreateShaderModule(device, &smd);

  uint32_t input[4] = {1, 2, 3, 4};
  WGPUBufferDescriptor sbd = {0};
  sbd.usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst;
  sbd.size = 16;
  WGPUBuffer storage = wgpuDeviceCreateBuffer(device, &sbd);
  wgpuQueueWriteBuffer(queue, storage, 0, input, 16);

  WGPUBufferDescriptor rbd = {0};
  rbd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
  rbd.size = 16;
  g_readback = wgpuDeviceCreateBuffer(device, &rbd);

  WGPUComputeState cs = {0};
  cs.module = mod;
  cs.entryPoint = sv("main");
  WGPUComputePipelineDescriptor cpd = {0};
  cpd.compute = cs;
  WGPUComputePipeline pipe = wgpuDeviceCreateComputePipeline(device, &cpd);

  WGPUBindGroupEntry e = {0};
  e.binding = 0; e.buffer = storage; e.size = 16;
  WGPUBindGroupDescriptor bgd = {0};
  bgd.layout = wgpuComputePipelineGetBindGroupLayout(pipe, 0);
  bgd.entryCount = 1; bgd.entries = &e;
  WGPUBindGroup bg = wgpuDeviceCreateBindGroup(device, &bgd);

  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
  WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(enc, NULL);
  wgpuComputePassEncoderSetPipeline(pass, pipe);
  wgpuComputePassEncoderSetBindGroup(pass, 0, bg, 0, NULL);
  wgpuComputePassEncoderDispatchWorkgroups(pass, 1, 1, 1);
  wgpuComputePassEncoderEnd(pass);
  wgpuCommandEncoderCopyBufferToBuffer(enc, storage, 0, g_readback, 0, 16);
  WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
  wgpuQueueSubmit(queue, 1, &cmd);

  WGPUBufferMapCallbackInfo ci = {0};
  ci.mode = WGPUCallbackMode_AllowSpontaneous;
  ci.callback = map_cb;
  wgpuBufferMapAsync(g_readback, WGPUMapMode_Read, 0, 16, ci);

  emscripten_set_main_loop(tick, 0, 0);
  return 0;
}
