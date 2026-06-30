import { spawn } from "node:child_process";
import { chromium } from "playwright";
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const srv = spawn("node", ["scripts/serve.mjs", "web", "8087"], { stdio: ["ignore","inherit","inherit"] });
await new Promise(r=>setTimeout(r,600));
const env = { ...process.env, VK_ICD_FILENAMES:"/usr/share/vulkan/icd.d/lvp_icd.json", VK_DRIVER_FILES:"/usr/share/vulkan/icd.d/lvp_icd.json" };
const sets = {
  D_spoof_gpu: ["--headless=new","--no-sandbox","--disable-gpu-sandbox","--in-process-gpu","--enable-unsafe-webgpu","--enable-features=Vulkan","--ignore-gpu-blocklist","--gpu-testing-vendor-id=0x8086","--gpu-testing-device-id=0x9bc4","--use-angle=vulkan"],
  E_no_swiftshader_feat: ["--headless=new","--no-sandbox","--disable-gpu-sandbox","--in-process-gpu","--enable-unsafe-webgpu","--enable-features=Vulkan","--ignore-gpu-blocklist","--disable-features=VulkanFromANGLE,SwiftShaderWebGPU","--use-angle=vulkan","--disable-software-rasterizer"],
};
for (const [n,args] of Object.entries(sets)) {
  console.log("=====",n);
  let b; try { b = await chromium.launch({executablePath:`${chromeDir}/chrome`, env, args}); } catch(e){ console.log("launch",e.message.slice(0,100)); continue; }
  try { const p = await (await b.newContext()).newPage();
    await p.goto("http://localhost:8087/blank.html",{waitUntil:"load",timeout:20000});
    console.log(JSON.stringify(await p.evaluate(async()=>{const a=await navigator.gpu?.requestAdapter(); if(!a)return{err:"no adapter"}; return{desc:a.info?.description,backend:a.info?.backendType,vendor:a.info?.vendor,storTex:a.limits.maxStorageTexturesPerShaderStage};})));
  } catch(e){ console.log("err",e.message.slice(0,120)); } finally { await b.close(); }
}
srv.kill(); process.exit(0);
