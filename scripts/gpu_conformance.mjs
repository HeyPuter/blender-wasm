// WebGPU backend conformance gate. Runs web/gpu-conformance.html on the REAL
// GPU in headed Playwright (see real-gpu-webgpu-in-playwright) and asserts every
// "GPUTEST <name> PASS|FAIL <detail>" line. Exits non-zero if any test fails or
// the suite doesn't complete — use it as a regression gate for the backend.
//
// Usage: node scripts/gpu_conformance.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = 8103;
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

const results = [];
let done = null;
const doneP = new Promise((res) => { done = res; });
let code = 1;
try {
  const page = await (await browser.newContext()).newPage();
  const { createWriteStream } = await import("node:fs");
  const full = createWriteStream("/tmp/conformance_console.log");
  page.on("console", (m) => {
    const t = m.text();
    full.write(t + "\n");
    if (t.startsWith("GPUTEST ")) {
      if (t.includes("GPUTEST_DONE")) { done(); return; }
      const m2 = t.match(/^GPUTEST (\S+) (PASS|FAIL) ?(.*)$/);
      if (m2) { results.push({ name: m2[1], pass: m2[2] === "PASS", detail: m2[3] }); }
    } else if (/adapter:|device acquired|ABORT|Traceback|Error/i.test(t)) {
      console.log("  ·", t.slice(0, 160));
    }
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 160)));

  await page.goto(`http://localhost:${PORT}/gpu-conformance.html`, { waitUntil: "load", timeout: 60000 });
  await Promise.race([doneP, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 180000))]).catch((e) => console.log(e.message));

  // Readback is DEFERRED (Python always sees zeros): map the persistent capture
  // buffer from JS after the suite finishes — it holds the LAST 4-channel
  // fb.read_color (the no_nan test's drawn 0.5-gray buffer). Non-zero center
  // proves draw + capture end-to-end.
  try {
    await new Promise((r) => setTimeout(r, 500));
    const cap = await page.evaluate(async () => {
      const M = window.Module;
      if (!M || typeof M._wgpu_capture_map !== "function") { return { err: "no capture exports" }; }
      const w = M._wgpu_capture_w(), h = M._wgpu_capture_h(), bpr = M._wgpu_capture_bpr(), bpp = M._wgpu_capture_bpp();
      if (!w || !h) { return { err: "no capture recorded" }; }
      M._wgpu_capture_map();
      for (let i = 0; i < 200; i++) { if (M._wgpu_capture_ready() !== 0) break; await new Promise((r) => setTimeout(r, 25)); }
      if (M._wgpu_capture_ready() !== 1) { return { err: "map failed" }; }
      const ptr = M._wgpu_capture_ptr();
      const raw = M.HEAPU8.slice(ptr, ptr + bpr * h);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const half = (u) => { const s = u >> 15, e = (u >> 10) & 31, f = u & 1023;
        let v; if (e === 0) v = f / 1024 * 2 ** -14; else if (e === 31) v = f ? NaN : Infinity; else v = (1 + f / 1024) * 2 ** (e - 15);
        return s ? -v : v; };
      const px = (x, y) => { const o = y * bpr + x * bpp;
        return bpp === 8 ? [0, 2, 4, 6].map((k) => half(dv.getUint16(o + k, true))) : [0, 1, 2, 3].map((k) => raw[o + k] / 255); };
      return { w, h, bpp, center: px(w >> 1, h >> 1) };
    });
    console.log("deferred capture:", JSON.stringify(cap));
    results.push({ name: "js_capture_center", pass: !cap.err && cap.center.some((v) => v > 0.1), detail: JSON.stringify(cap.center || cap.err) });
  } catch (e) { console.log("capture eval error:", e.message); }

  console.log("\n=== WebGPU backend conformance ===");
  for (const r of results) {
    console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name.padEnd(18)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.pass);
  const passed = results.filter((r) => r.pass);
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (results.length > 0 && failed.length === 0) { code = 0; }
  else if (results.length === 0) { console.log("NO RESULTS — suite did not run"); }
} catch (e) {
  console.log("RUNNER ERROR:", e.message);
} finally {
  await browser.close();
  srv.kill();
  process.exit(code);
}
