import gpu from '@kmamal/gpu';
const navigatorGpu = gpu.create([]);
const adapter = await navigatorGpu.requestAdapter();
if (!adapter) { console.log("NO ADAPTER"); process.exit(1); }
const info = adapter.info || {};
const L = adapter.limits;
console.log("adapter:", JSON.stringify({vendor:info.vendor, device:info.device, description:info.description}));
console.log("maxStorageTexturesPerShaderStage:", L.maxStorageTexturesPerShaderStage);
console.log("maxComputeWorkgroupSizeX:", L.maxComputeWorkgroupSizeX);
console.log("maxComputeInvocationsPerWorkgroup:", L.maxComputeInvocationsPerWorkgroup);
console.log("maxStorageBuffersPerShaderStage:", L.maxStorageBuffersPerShaderStage);
const dev = await adapter.requestDevice();
console.log("device ok:", !!dev);
process.exit(0);
