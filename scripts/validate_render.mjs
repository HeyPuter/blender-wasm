// END-TO-END: render an actual triangle in browser WebGPU using a real Blender
// shader translated to WGSL (gpu_shader_3D_uniform_color), and read back pixels.
// Proves Blender GLSL -> SPIR-V -> WGSL -> WGPURenderPipeline -> PIXELS.
// Args: <vert.wgsl> <frag.wgsl>. chromium + SwiftShader on a served localhost.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8096;
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const [vertPath, fragPath] = process.argv.slice(2);

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 600));
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
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/blank.html`, { waitUntil: "load", timeout: 30000 });
  const vert = readFileSync(vertPath, "utf8");
  const frag = readFileSync(fragPath, "utf8");
  const res = await page.evaluate(async ({ vert, frag }) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const W = 64, H = 64;
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: device.createShaderModule({ code: vert }), entryPoint: "main",
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: device.createShaderModule({ code: frag }), entryPoint: "main",
        targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    // UBO: constants_1 { mat4 MVP (identity), vec4 color (orange), u32 srgbTarget=0 }.
    const ubo = new ArrayBuffer(96);
    const f = new Float32Array(ubo);
    f.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], 0);     // MVP identity
    f.set([1.0, 0.5, 0.2, 1.0], 16);                      // color (offset 64B)
    new Uint32Array(ubo)[20] = 0;                          // srgbTarget (offset 80B)
    const uboBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uboBuf, 0, ubo);
    const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uboBuf } }] });
    // Big triangle covering the center.
    const verts = new Float32Array([-0.8,-0.8,0,  0.8,-0.8,0,  0.0,0.8,0]);
    const vbuf = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vbuf, 0, verts);
    const tex = device.createTexture({ size: [W,H], format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(),
      clearValue: { r:0,g:0,b:0,a:1 }, loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(3); pass.end();
    // Copy texture -> buffer for readback (256-byte row alignment).
    const bpr = 256;
    const rb = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow: bpr }, [W,H]);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(rb.getMappedRange()).slice();
    // Center pixel.
    const cx = 32, cy = 32, off = cy*bpr + cx*4;
    return { px: [data[off], data[off+1], data[off+2], data[off+3]] };
  }, { vert, frag });
  const [r,g,b,a] = res.px;
  console.log(`center pixel rgba = (${r}, ${g}, ${b}, ${a})`);
  // Expect ~orange (255,128,51,255); allow tolerance.
  if (r > 200 && g > 90 && g < 170 && b < 100 && a > 200) {
    console.log("RENDER PIXELS OK — Blender shader rendered the expected color via WebGPU");
    code = 0;
  } else {
    console.log("RENDER PIXELS UNEXPECTED (drew, but color off — check srgb/layout)");
  }
} catch (e) {
  console.log("RUNNER ERROR:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(code);
}
