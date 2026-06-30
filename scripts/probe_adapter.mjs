import { spawn } from "node:child_process";
import { chromium } from "playwright";
const home = process.env.HOME;
const chromeDir = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64`;
const srv = spawn("node", ["scripts/serve.mjs", "web", "8085"], { stdio:["ignore","inherit","inherit"] });
await new Promise(r=>setTimeout(r,600));
const env = { ...process.env, DISPLAY: ":99",
  VK_ICD_FILENAMES:"/usr/share/vulkan/icd.d/lvp_icd.json", VK_DRIVER_FILES:"/usr/share/vulkan/icd.d/lvp_icd.json" };
const base = ["--no-sandbox","--disable-gpu-sandbox","--enable-unsafe-webgpu","--enable-features=Vulkan","--ignore-gpu-blocklist","--use-webgpu-adapter=default","--use-vulkan=native"];
const sets = {
  headless: ["--headless=new","--in-process-gpu",...base],
  xvfb: [...base],  // non-headless on :99
};
for (const [n,extra] of Object.entries(sets)) {
  console.log("=====",n);
  let b; try { b = await chromium.launch({executablePath:`${chromeDir}/chrome`, headless: n==="headless", env, args: extra}); }
  catch(e){ console.log("launch",e.message.slice(0,120)); continue; }
  try { const p = await (await b.newContext()).newPage();
    await p.goto("http://localhost:8085/blank.html",{waitUntil:"load",timeout:25000});
    console.log(JSON.stringify(await p.evaluate(async()=>{const a=await navigator.gpu?.requestAdapter(); if(!a)return{err:"no adapter"}; return{desc:a.info?.description,backend:a.info?.backendType,vendor:a.info?.vendor,storTex:a.limits.maxStorageTexturesPerShaderStage,wgX:a.limits.maxComputeWorkgroupSizeX};})));
  } catch(e){ console.log("ERR",e.message.slice(0,150)); } finally { await b.close(); }
}
srv.kill(); process.exit(0);
