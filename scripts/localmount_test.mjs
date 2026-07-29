// Verifies the custom "localdir" wasmfs backend end to end WITHOUT the native
// directory picker (which can't be automated): an OPFS FileSystemDirectoryHandle
// exposes the exact same getFile()/entries() API as a picked folder, so we
//   1. build a small tree in OPFS,
//   2. stash its handle in the blender-localmount IDB (as the page does),
//   3. enumerate it and call wasmfs_mount_localdir("/mnt/...", listing),
//   4. read the files back through Blender's FS — exercising the async read
//      hook (localdir_lib.js) which fetches bytes lazily from the handle.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chromium } from "playwright";

const srv = spawn("npx", ["vite", "--port", "4181", "--strictPort"],
                  { cwd: "demo", stdio: "ignore" });
await new Promise(r => setTimeout(r, 2500));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const full = createWriteStream("/tmp/localmount_test.log");
page.on("console", (m) => full.write(m.text() + "\n"));
page.on("pageerror", (e) => full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"));

await page.goto("http://localhost:4181/", { waitUntil: "load" });
const booted = await (async () => {
  for (let i = 0; i < 240; i++) {
    const s = await page.evaluate(() => window.__BGUI__ || {});
    if (s.window) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
})();
console.log("boot ok=" + booted);
if (!booted) { await browser.close(); srv.kill(); process.exit(1); }

const result = await page.evaluate(async () => {
  const enc = new TextEncoder();
  const CONTENT = "hello from a real lazy mount — no copying!\n".repeat(500); // ~21 KB
  const NESTED = "nested file bytes";

  // 1. Build an OPFS tree: mnttest_dir/hello.txt + mnttest_dir/sub/deep.txt
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("mnttest_dir", { create: true });
  {
    const fh = await dir.getFileHandle("hello.txt", { create: true });
    const w = await fh.createWritable(); await w.write(enc.encode(CONTENT)); await w.close();
    const sub = await dir.getDirectoryHandle("sub", { create: true });
    const fh2 = await sub.getFileHandle("deep.txt", { create: true });
    const w2 = await fh2.createWritable(); await w2.write(enc.encode(NESTED)); await w2.close();
  }

  // 2. Stash the handle where the proxy worker reads it.
  await new Promise((res, rej) => {
    const rq = indexedDB.open("blender-localmount", 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles", { keyPath: "key" });
    };
    rq.onsuccess = () => {
      const tx = rq.result.transaction("handles", "readwrite");
      tx.objectStore("handles").put({ key: "current", handle: dir });
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    };
    rq.onerror = () => rej(rq.error);
  });

  // 3. Enumerate + mount.
  const lines = [];
  const walk = async (d, prefix) => {
    for await (const [name, h] of d.entries()) {
      const rel = prefix ? prefix + "/" + name : name;
      if (h.kind === "directory") { lines.push("D\t" + rel); await walk(h, rel); }
      else lines.push("F\t" + rel);
    }
  };
  await walk(dir, "");
  const rc = Module.ccall("wasmfs_mount_localdir", "number",
                          ["string", "string"], ["/mnt/mnttest_dir", lines.join("\n")]);
  // Detached mount: poll for completion.
  let status = 0;
  for (let i = 0; i < 300 && status === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    status = Module.ccall("wasmfs_localdir_mount_status", "number", [], []);
  }

  // 4. Read back through Blender's FS (exercises the async read hook).
  const dec = new TextDecoder();
  const readdir = (p) => { try { return Module.FS.readdir(p).filter(n => n !== "." && n !== ".."); } catch (e) { return "ERR " + e; } };
  const readfile = (p) => { try { return dec.decode(Module.FS.readFile(p)); } catch (e) { return "ERR " + e; } };
  const hello = readfile("/mnt/mnttest_dir/hello.txt");
  const deep = readfile("/mnt/mnttest_dir/sub/deep.txt");

  return {
    rc, status, lines,
    listMount: readdir("/mnt/mnttest_dir"),
    listSub: readdir("/mnt/mnttest_dir/sub"),
    helloOk: hello === CONTENT,
    helloLen: hello.length, expectLen: CONTENT.length,
    deepOk: deep === NESTED,
    helloHead: hello.slice(0, 40),
  };
});

console.log("MOUNT RESULT:\n" + JSON.stringify(result, null, 2));
const pass = result.rc === 0 && result.status === 1 && result.helloOk && result.deepOk;
console.log(pass ? "\n✅ PASS — lazy mount reads correct bytes" : "\n❌ FAIL");
await browser.close(); srv.kill();
process.exit(pass ? 0 : 1);
