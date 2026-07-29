/* Blender-wasm release demo.
 *
 * Assets (Blender 5.3 scripts/datafiles + the CPython stdlib) ship as
 * assets.tar.zst. Zero-copy load (files + pattern copied from gecko-wasm's
 * chrome-fs.ts + provider_backend.h + provider-fs.js): download + zstd-
 * decompress into ONE buffer, index the tar into path -> Uint8Array VIEWS
 * (no copies), and expose it as an FsProvider (stat/readdir/readFile). The
 * WasmFS ProviderBackend (demo/provider_backend.cpp) mounts it at /assets and
 * reads it provider-first, materializing each file on open — no per-file
 * extraction, no OPFS write storm. Only the persistent HOME touches OPFS
 * (/opfs/home). The wasm itself ships as blender.wasm.zst, decompressed each
 * visit and fed to emscripten via Module.instantiateWasm.
 */
import { ZSTDDecoder } from "zstddec";

/* ---- Splash UI: progress bar + startup console (ported from gecko-wasm's
 * demo/chrome/src/main.ts). ---- */
const splashEl = document.getElementById("splash");
const splashShell = document.getElementById("splash-shell");
const stageCard = document.getElementById("stage-card");
const stageEl = document.querySelector(".stage");
const statusEl = document.getElementById("splash-status");
const phaseEl = document.getElementById("progress-phase");
const percentEl = document.getElementById("progress-percent");
const fillEl = document.getElementById("progress-fill");
const progressbar = document.querySelector(".progress-track");
const consoleOutput = document.getElementById("console-output");
const startBtn = document.getElementById("start-btn");
const gpuWarning = document.getElementById("gpu-warning");
const gpuWarningText = document.getElementById("gpu-warning-text");
const gpuAckRow = document.getElementById("gpu-ack-row");
const gpuAck = document.getElementById("gpu-ack");

function setUiPhase(next) {
  splashShell.dataset.phase = next;
  stageCard.dataset.phase = next;
  stageEl.dataset.phase = next;
}

/* Mirror console.{log,warn,error} into the on-page startup log. */
const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const MAX_CONSOLE_LINES = 400;
const stringifyArg = (a) => {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};
function appendConsoleLine(level, args) {
  const line = document.createElement("div");
  line.className = `console-line ${level}`;
  const prefix = document.createElement("span");
  prefix.className = "console-prefix";
  prefix.textContent = `[${level}] `;
  line.append(prefix, args.map(stringifyArg).join(" "));
  consoleOutput.appendChild(line);
  while (consoleOutput.childElementCount > MAX_CONSOLE_LINES) {
    consoleOutput.firstElementChild?.remove();
  }
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}
console.log = (...a) => { appendConsoleLine("log", a); nativeConsole.log(...a); };
console.warn = (...a) => { appendConsoleLine("warn", a); nativeConsole.warn(...a); };
console.error = (...a) => { appendConsoleLine("error", a); nativeConsole.error(...a); };
const log = (m) => console.log(m);

function formatBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
function setProgress(p) {
  const pct = p.percent == null ? undefined : Math.max(0, Math.min(1, p.percent));
  statusEl.textContent = (p.loaded && p.total)
    ? `${p.message} · ${formatBytes(p.loaded)} / ${formatBytes(p.total)}`
    : p.message;
  phaseEl.textContent = p.phase[0].toUpperCase() + p.phase.slice(1);
  if (pct == null) { progressbar.removeAttribute("aria-valuenow"); percentEl.textContent = ""; return; }
  const r = Math.round(pct * 100);
  fillEl.style.width = `${r}%`;
  progressbar.setAttribute("aria-valuenow", String(r));
  percentEl.textContent = `${r}%`;
}
/* Legacy status() shim used elsewhere in this file. */
const status = (t) => { statusEl.textContent = t; };

/* ---- Combined download manager: the asset tar and the engine wasm (both
 * zstd) download CONCURRENTLY and share one progress bar (summed bytes), then
 * both are decompressed. ---- */
const dl = {
  assets: { loaded: 0, total: 0 },
  wasm: { loaded: 0, total: 0 },
};
function renderDownloads() {
  const loaded = dl.assets.loaded + dl.wasm.loaded;
  const total = (dl.assets.total && dl.wasm.total) ? dl.assets.total + dl.wasm.total : undefined;
  setProgress({
    phase: "downloading", loaded, total,
    percent: total ? loaded / total : undefined,
    message: "Downloading Blender",
  });
}
/* Stream `url` with progress into `dl[key]`, return the compressed bytes. */
async function fetchZst(url, key) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  dl[key].total = Number(r.headers.get("Content-Length")) || 0;
  const reader = r.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    dl[key].loaded += value.byteLength;
    renderDownloads();
  }
  if (!dl[key].total) dl[key].total = dl[key].loaded;
  renderDownloads();
  const out = new Uint8Array(dl[key].loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const decoder = new ZSTDDecoder();
const manifest = await (await fetch("manifest.json")).json();

/* ---- In-memory tar FsProvider (pattern + code from gecko-wasm chrome-fs.ts).
 * The tar is indexed as path -> Uint8Array VIEWS into the one decompressed
 * buffer (zero-copy) plus a directory tree; makeProvider() exposes it as the
 * {stat, readdir, readFile} FsProvider that the WasmFS ProviderBackend
 * (demo/provider_backend.cpp + provider-fs.js) reads, provider-first, for
 * /assets. Paths are mount-relative. ---- */
const textDecoder = new TextDecoder();
function parseTarString(bytes, start, length) {
  let end = start;
  const max = start + length;
  while (end < max && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(start, end));
}
function parseTarSize(bytes, start) {
  const first = bytes[start];
  if (first & 0x80) {
    let size = first & 0x7f;
    for (let i = start + 1; i < start + 12; i++) size = (size * 256) + bytes[i];
    return size;
  }
  const raw = parseTarString(bytes, start, 12).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}
function parsePax(data) {
  const text = textDecoder.decode(data);
  const out = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, i + length - 1);
    const eq = record.indexOf("=");
    if (eq >= 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}
function tarEntryName(bytes, offset) {
  const name = parseTarString(bytes, offset, 100);
  const prefix = parseTarString(bytes, offset + 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}
function isEmptyBlock(bytes, offset) {
  for (let i = offset; i < offset + 512; i++) if (bytes[i] !== 0) return false;
  return true;
}
// Register a file/dir path into the directory tree, creating implicit parents.
function addToTree(dirs, parts, isDir) {
  let dir = "";
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    let children = dirs.get(dir);
    if (!children) { children = new Set(); dirs.set(dir, children); }
    children.add(parts[i]);
    if (isLast && !isDir) break;
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    if (isLast && !dirs.has(dir)) dirs.set(dir, new Set());
  }
}
function indexTar(bytes) {
  const files = new Map();          // path -> Uint8Array view (zero-copy)
  const dirs = new Map([["", new Set()]]);
  let offset = 0;
  let pax, longName;
  while (offset + 512 <= bytes.length && !isEmptyBlock(bytes, offset)) {
    const type = String.fromCharCode(bytes[offset + 156] || 0);
    const size = parseTarSize(bytes, offset + 124);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error("asset-fs: truncated tar");
    const data = bytes.subarray(dataStart, dataEnd);
    const name = (pax?.path ?? longName ?? tarEntryName(bytes, offset)).replace(/^\.\//, "");
    pax = undefined; longName = undefined;
    const parts = name.split("/").filter(Boolean);
    if (name.startsWith("/") || parts.includes("..")) throw new Error(`asset-fs: unsafe path ${name}`);
    if (type === "x") {
      pax = parsePax(data);
    } else if (type === "L") {
      longName = parseTarString(data, 0, data.length);
    } else if (parts.length && (type === "0" || type === "\0" || type === "")) {
      files.set(parts.join("/"), data);
      addToTree(dirs, parts, false);
    } else if (parts.length && type === "5") {
      addToTree(dirs, parts, true);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { files, dirs };
}
const normalizeAssetPath = (p) => p.split("/").filter(Boolean).join("/");
function makeAssetProvider(index) {
  return {
    stat(path) {
      const p = normalizeAssetPath(path);
      const file = index.files.get(p);
      if (file) return { size: file.byteLength, isDir: false };
      if (index.dirs.has(p)) return { size: 0, isDir: true };
      return null;
    },
    readdir(path) {
      const children = index.dirs.get(normalizeAssetPath(path));
      if (!children) throw new Error(`asset-fs: no such directory ${path}`);
      return [...children];
    },
    readFile(path) {
      const file = index.files.get(normalizeAssetPath(path));
      if (!file) throw new Error(`asset-fs: no such file ${path}`);
      return file; // zero-copy view into the one decompressed buffer
    },
  };
}

/* ---- GPU capability gate ------------------------------------------------
 * Probe the WebGPU adapter EARLY (concurrent with the download; no user
 * activation needed) so the user learns about a missing/software renderer
 * before waiting for ~50 MB. If WebGPU is absent the Launch button stays
 * disabled; if it falls back to a software renderer (SwiftShader / llvmpipe /
 * Dawn fallback) the button is greyed out until the user ticks an
 * acknowledgement checkbox. A real GPU shows nothing and launches normally. */
let assetsReady = false;
let gpuStatus = null; /* { ok, software, fatal, desc, message } once resolved */

function refreshStartGate() {
  /* No hard blocker resolves the button purely on asset readiness; a fatal GPU
   * problem keeps it disabled; a software fallback needs the ack checkbox. */
  if (gpuStatus && gpuStatus.fatal) {
    startBtn.disabled = true;
    return;
  }
  const needAck = !!(gpuStatus && gpuStatus.software);
  const acked = needAck ? gpuAck.checked : true;
  startBtn.disabled = !assetsReady || !acked;
}

function applyGpuStatus(s) {
  gpuStatus = s;
  if (s.ok) {
    gpuWarning.hidden = true;
    gpuAckRow.hidden = true;
  } else {
    gpuWarning.hidden = false;
    gpuWarningText.innerHTML = s.message;
    /* Only a software fallback is launch-able (via the ack); a total absence of
     * WebGPU cannot start Blender, so no override checkbox is offered. */
    gpuAckRow.hidden = !s.software;
  }
  refreshStartGate();
}

async function probeGpu() {
  if (!navigator.gpu) {
    return { ok: false, software: false, fatal: true, desc: "",
      message: "This browser has no <b>WebGPU</b> support, so Blender cannot start. " +
        "Use a recent Chromium-based browser (Chrome/Edge 113+) with hardware acceleration enabled." };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { ok: false, software: false, fatal: true, desc: "",
        message: "No <b>WebGPU adapter</b> is available, so Blender cannot start. " +
          "Enable hardware acceleration / GPU access in your browser and reload." };
    }
    const info = (adapter.info) || {};
    const desc = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" | ");
    const software = adapter.isFallbackAdapter ||
      /swiftshader|software|llvmpipe|lavapipe|basic|warp|microsoft basic/i.test(desc);
    if (desc) log("WEBGPU_ADAPTER " + desc);
    if (software) {
      return { ok: false, software: true, fatal: false, desc,
        message: "WebGPU is running on a <b>software renderer</b>" +
          (desc ? " (<code>" + desc + "</code>)" : "") +
          " — Blender will be <b>extremely slow</b>. For real performance, enable hardware " +
          "GPU acceleration (Chrome: <code>--enable-unsafe-webgpu --enable-features=Vulkan " +
          "--ignore-gpu-blocklist</code>)." };
    }
    return { ok: true, software: false, fatal: false, desc, message: "" };
  } catch (e) {
    return { ok: false, software: false, fatal: true, desc: "",
      message: "WebGPU probe failed (" + (e && e.message || e) + "). Blender cannot start." };
  }
}

/* Kick the probe off immediately and reflect it in the UI as soon as it lands. */
gpuAck.addEventListener("change", refreshStartGate);
probeGpu().then(applyGpuStatus).catch(() => {});

/* ---- Download the asset tar + engine wasm CONCURRENTLY (one combined
 * progress bar), then zstd-decompress both. `assetProvider` (the zero-copy tar
 * FsProvider) and `wasmBytes` are consumed when the user clicks Launch. ---- */
setUiPhase("loading");
await decoder.init();
const [assetsTar, wasmBytes] = await Promise.all([
  fetchZst("assets.tar.zst", "assets").then((z) => {
    setProgress({ phase: "decompressing", percent: 1, message: "Decompressing assets" });
    return decoder.decode(z, manifest["assets.tar.zst"]);
  }),
  fetchZst("blender.wasm.zst", "wasm").then((z) => {
    setProgress({ phase: "decompressing", percent: 1, message: "Decompressing Blender" });
    return decoder.decode(z, manifest["blender.wasm.zst"]);
  }),
]);
const assetProvider = makeAssetProvider(indexTar(assetsTar));
log(`assets indexed zero-copy: ${(assetsTar.length / 1048576) | 0} MB · wasm ${(wasmBytes.length / 1048576) | 0} MB`);
setProgress({ phase: "ready", percent: 1, message: "Ready to launch" });
setUiPhase("ready");
assetsReady = true;
refreshStartGate();

/* ---- WGSL translation cache (IndexedDB + shipped seed) ---- */
const idbOpen = () => new Promise((res, rej) => {
  const rq = indexedDB.open("blender-fs", 2);
  rq.onupgradeneeded = () => {
    const db = rq.result;
    if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "path" });
    if (!db.objectStoreNames.contains("wgsl")) db.createObjectStore("wgsl", { keyPath: "key" });
  };
  rq.onsuccess = () => res(rq.result);
  rq.onerror = () => rej(rq.error);
});

/* ---- boot ---- */
window.__BGUI__ = { booted: false, device: false, window: false };
const scan = (t) => {
  if (t.includes("WEBGPU_CONTEXT") && t.includes("real device acquired")) window.__BGUI__.device = true;
  /* First frame that actually drew something (not the black startup clear):
   * swap the splash/console for the live canvas. */
  if (t.includes("WGPU_FIRST_CONTENT") && !window.__BGUI__.window) {
    window.__BGUI__.window = true;
    splashEl.classList.add("done");
    canvas.classList.add("ready");
  }
};
const canvas = document.getElementById("canvas");
const fitCanvas = () => {
  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
};
fitCanvas();
window.addEventListener("resize", fitCanvas);
window.addEventListener("contextmenu", (e) => e.preventDefault());

/* Keep pinch-to-zoom inside Blender instead of zooming the browser page.
 * Under PROXY_TO_PTHREAD emscripten forwards wheel events to the Blender render
 * thread ASYNChronously and, on that proxied path, never calls preventDefault
 * (libhtml5 skips it when a targetThread is set) — so GHOST returning "handled"
 * can't cancel the browser's default in time and a trackpad pinch (ctrl+wheel)
 * zooms the page. We cancel the default here on the main thread, synchronously;
 * the event still reaches emscripten's listener, so Blender receives the wheel
 * and zooms its viewport. `passive:false` is required for preventDefault on
 * wheel to take effect. touch-action:none (CSS) covers touchscreen pinch/pan;
 * gesture* covers Safari's trackpad pinch. */
const eatGesture = (e) => e.preventDefault();
canvas.addEventListener("wheel", eatGesture, { passive: false });
canvas.addEventListener("gesturestart", eatGesture);
canvas.addEventListener("gesturechange", eatGesture);
canvas.addEventListener("gestureend", eatGesture);

/* ---- File ▸ Open hijack: a REAL, lazy mount (no copying) of a folder the
 * user picks on their machine. Blender's wm_open_mainfile invoke (wasm build)
 * calls window.__blenderFileOpenHook() on every File ▸ Open press and forces
 * its file dialog to /mnt. We show the browser's directory picker, enumerate
 * the folder's tree (names only, no file contents), stash the
 * FileSystemDirectoryHandle in IndexedDB, and hand the tree to the custom
 * wasmfs "localdir" backend (localdir_backend.cpp) via wasmfs_mount_localdir.
 * Blender then reads file bytes on demand straight from disk through the
 * backend's async JS hooks (localdir_lib.js). Read-only. Blender's file
 * browser stays hidden until the mount lands; then we call
 * blender_web_file_open_at("/mnt/<folder>") to open it right at the folder. ---- */
const MOUNT_ROOT = "/mnt";

/* Persist the picked handle where the wasmfs proxy worker can read it back
 * (a dedicated DB so we don't touch the wgsl/files schema). One record per
 * mount point; "current" is kept as a legacy fallback key. */
const mountIdbPut = (key, handle) => new Promise((res, rej) => {
  const rq = indexedDB.open("blender-localmount", 1);
  rq.onupgradeneeded = () => {
    const db = rq.result;
    if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles", { keyPath: "key" });
  };
  rq.onsuccess = () => {
    const db = rq.result;
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put({ key, handle });
    tx.objectStore("handles").put({ key: "current", handle });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  };
  rq.onerror = () => rej(rq.error);
});

/* Read a stored directory handle back from IDB (by mount-point key). */
const mountIdbGet = (key) => new Promise((res) => {
  const rq = indexedDB.open("blender-localmount", 1);
  rq.onupgradeneeded = () => {
    const db = rq.result;
    if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles", { keyPath: "key" });
  };
  rq.onsuccess = () => {
    try {
      const g = rq.result.transaction("handles").objectStore("handles").get(key);
      g.onsuccess = () => res(g.result ? g.result.handle : null);
      g.onerror = () => res(null);
    } catch (e) { res(null); }
  };
  rq.onerror = () => res(null);
});

/* Serve read-write permission promotions for the localdir mount. The backend's
 * write hook runs on a wasmfs proxy worker with NO user activation, so it can't
 * call requestPermission itself; it asks here over a BroadcastChannel. The page
 * still has transient activation for ~5s after the user's Save click, so the
 * prompt (if any) succeeds. Set up once, before any mount. */
const permChannel = new BroadcastChannel("localdir-perm");
permChannel.onmessage = async (e) => {
  const d = e.data;
  if (!d || d.type !== "request") return;
  let granted = false;
  try {
    const dir = (await mountIdbGet(d.mountPoint)) || (await mountIdbGet("current"));
    if (dir && dir.requestPermission) {
      let p = await dir.queryPermission({ mode: "readwrite" });
      if (p !== "granted") p = await dir.requestPermission({ mode: "readwrite" });
      granted = p === "granted";
    }
  } catch (err) {
    log("localdir readwrite promotion failed: " + (err && err.message || err));
  }
  permChannel.postMessage({ type: "response", id: d.id, granted });
};

/* Walk the directory handle, collecting "<D|F>\t<relative/path>" lines. This
 * only lists entries (and getFile() is NOT called) — no bytes are read. */
async function enumerateTree(dirHandle) {
  const lines = [];
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      const rel = prefix ? prefix + "/" + name : name;
      if (handle.kind === "directory") {
        lines.push("D\t" + rel);
        await walk(handle, rel);
      } else {
        lines.push("F\t" + rel);
      }
    }
  };
  await walk(dirHandle, "");
  return lines;
}

const mountedNames = new Set();
let pickerBusy = false;

/* Primary path (Chromium): File System Access lazy mount. Returns the mount
 * point (e.g. "/mnt/proj") or null if the user cancelled. */
async function mountViaFileSystemAccess() {
  const dir = await window.showDirectoryPicker({ mode: "read" });
  const mountPoint = MOUNT_ROOT + "/" + dir.name;
  if (!mountedNames.has(dir.name)) {
    await mountIdbPut(mountPoint, dir);
    const lines = await enumerateTree(dir);
    /* Spawns a detached helper pthread and returns immediately; the mount
     * itself must not block the main thread (it creates a proxy worker). */
    const rc = window.Module.ccall(
      "wasmfs_mount_localdir", "number",
      ["string", "string"], [mountPoint, lines.join("\n")]);
    if (rc !== 0) throw new Error("mount spawn failed (" + rc + ")");
    let status = 0;
    for (let i = 0; i < 300 && status === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = window.Module.ccall("wasmfs_localdir_mount_status", "number", [], []);
    }
    if (status !== 1) throw new Error("mount did not complete (status " + status + ")");
    mountedNames.add(dir.name);
    log("mounted " + lines.length + " entries at " + mountPoint);
  }
  return mountPoint;
}

/* Fallback (Firefox/Safari — no showDirectoryPicker): pop an HTML modal asking
 * the user to drag & drop a folder, then read it via the drag-and-drop entry
 * API (webkitGetAsEntry). The dropped tree is exposed as an on-demand
 * FsProvider (same ProviderBackend as /assets): only the directory listing is
 * walked up front; each file's bytes are read lazily from its File object when
 * Blender actually opens it — no copy. Read-only (drag-drop can't write back;
 * saves go through the blob-download path). Returns the mount point or null. */
function dropModalPick() {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,.6);font:14px system-ui,sans-serif;color:#ddd;";
    const zone = document.createElement("div");
    zone.id = "localdir-dropzone";
    zone.style.cssText = "width:440px;max-width:86vw;padding:26px;border-radius:10px;background:#1c1c1c;" +
      "border:2px dashed #555;text-align:center;transition:border-color .12s,background .12s;";
    zone.innerHTML =
      "<div style='font-size:17px;font-weight:600;margin-bottom:8px'>Open a folder</div>" +
      "<div style='color:#aaa;line-height:1.5'>Your browser doesn't support the folder picker.<br>" +
      "<b>Drag &amp; drop a folder here</b> to open it.</div>" +
      "<div id='dz-status' style='margin-top:14px;color:#e87d0d;min-height:18px'></div>" +
      "<button id='dz-cancel' style='margin-top:16px;padding:6px 16px;border:0;border-radius:5px;" +
      "background:#333;color:#ddd;cursor:pointer'>Cancel</button>";
    ov.appendChild(zone);
    document.body.appendChild(ov);
    const statusEl = zone.querySelector("#dz-status");
    let done = false;
    const finish = (val) => { if (done) return; done = true; ov.remove(); resolve(val); };

    zone.querySelector("#dz-cancel").onclick = () => finish(null);
    ov.addEventListener("click", (e) => { if (e.target === ov) finish(null); });

    const hl = (on) => { zone.style.borderColor = on ? "#e87d0d" : "#555"; zone.style.background = on ? "#242018" : "#1c1c1c"; };
    ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); hl(true); }));
    ["dragleave", "dragend"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); hl(false); }));

    zone.addEventListener("drop", async (e) => {
      e.preventDefault(); e.stopPropagation(); hl(false);
      const items = e.dataTransfer && e.dataTransfer.items;
      let rootEntry = null;
      for (let i = 0; items && i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
        if (entry && entry.isDirectory) { rootEntry = entry; break; }
      }
      if (!rootEntry) { statusEl.textContent = "Please drop a folder, not a file."; return; }
      try {
        statusEl.textContent = "Reading “" + rootEntry.name + "”…";
        const mountPoint = await mountDropEntry(rootEntry);
        finish(mountPoint);
      } catch (err) {
        statusEl.textContent = "Failed: " + (err && err.message || err);
      }
    });
  });
}

/* mountId 1 = the dropped-folder provider (0 = /assets). One at a time. */
const DROP_MOUNT = 1;

/* Walk the dropped tree (names only — NO byte reads) and expose it as an
 * on-demand FsProvider backed by the FileSystemFileEntry objects, then mount it
 * read-only at /mnt/<name> via the ProviderBackend. Bytes are pulled lazily
 * (File.arrayBuffer) only when Blender opens a file. */
async function mountDropEntry(rootEntry) {
  const mountPoint = MOUNT_ROOT + "/" + rootEntry.name;
  const readDir = (dirEntry) => new Promise((res, rej) => {
    const reader = dirEntry.createReader();
    const out = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) return res(out);   // readEntries returns in batches
      out.push(...batch); step();
    }, rej);
    step();
  });
  const getFile = (fileEntry) => new Promise((res, rej) => fileEntry.file(res, rej));

  const files = new Map();               // relpath -> FileSystemFileEntry
  const dirs = new Map([["", new Set()]]);
  const walk = async (dirEntry, prefix) => {
    for (const ent of await readDir(dirEntry)) {
      const rel = prefix ? prefix + "/" + ent.name : ent.name;
      const parts = rel.split("/").filter(Boolean);
      if (ent.isDirectory) { addToTree(dirs, parts, true); await walk(ent, rel); }
      else { files.set(rel, ent); addToTree(dirs, parts, false); }
    }
  };
  await walk(rootEntry, "");

  const provider = {
    async stat(path) {
      const p = normalizeAssetPath(path);
      const entry = files.get(p);
      if (entry) { const f = await getFile(entry); return { size: f.size, isDir: false }; }
      if (dirs.has(p)) return { size: 0, isDir: true };
      return null;
    },
    readdir(path) {
      const children = dirs.get(normalizeAssetPath(path));
      if (!children) throw new Error(`drop-fs: no such directory ${path}`);
      return [...children];
    },
    async readFile(path) {
      const entry = files.get(normalizeAssetPath(path));
      if (!entry) throw new Error(`drop-fs: no such file ${path}`);
      const f = await getFile(entry);           // lazy: only when opened
      return new Uint8Array(await f.arrayBuffer());
    },
  };

  Module.geckoProviders = Module.geckoProviders || {};
  Module.geckoProviders[DROP_MOUNT] = provider;
  const rc = window.Module.ccall("blender_web_mount_provider", "number",
                                 ["number", "string"], [DROP_MOUNT, mountPoint]);
  if (rc !== 0) throw new Error("provider mount failed (" + rc + ")");
  log("mounted " + files.size + " files at " + mountPoint + " (drag-drop, on-demand)");
  return mountPoint;
}

/* Save (Chromium, no folder mounted yet): pick a destination folder, mount it,
 * then tell Blender to open its save browser there (blender_web_file_save_at →
 * phase 2). Mirrors the Open folder picker. */
window.__blenderSaveHook = async () => {
  if (pickerBusy) return;
  if (!window.Module || !window.Module.ccall) return;
  pickerBusy = true;
  try {
    const mountPoint = await mountViaFileSystemAccess();
    if (mountPoint) {
      window.Module.ccall("blender_web_file_save_at", null, ["string"], [mountPoint + "/"]);
    }
  } catch (e) {
    if (!(e && e.name === "AbortError")) log("Save folder pick failed: " + (e && e.message || e));
  } finally {
    pickerBusy = false;
  }
};

/* Save (Firefox/Safari): Blender wrote the .blend to an in-memory temp path;
 * read it and download as a blob. */
window.__blenderSaveDownload = (path) => {
  try {
    const data = window.Module.FS.readFile(path); // Uint8Array
    const name = path.split("/").pop() || "untitled.blend";
    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    try { window.Module.FS.unlink(path); } catch (e) {}
    log("downloaded " + name + " (" + data.length + " bytes)");
  } catch (e) {
    log("save download failed: " + (e && e.message || e));
  }
};

window.__blenderFileOpenHook = async () => {
  if (pickerBusy) return;
  if (!window.Module || !window.Module.ccall) return;
  pickerBusy = true;
  try {
    /* Relies on transient user activation of the File ▸ Open click (FS-Access
     * path). Cancel (AbortError / null) → do nothing, no file browser. */
    const mountPoint = window.showDirectoryPicker
      ? await mountViaFileSystemAccess()
      : await dropModalPick();
    if (mountPoint) {
      /* Only NOW open Blender's file browser, pointed at the folder. */
      window.Module.ccall("blender_web_file_open_at", null, ["string"], [mountPoint + "/"]);
    }
  } catch (e) {
    if (!(e && e.name === "AbortError")) {
      log("File ▸ Open mount failed: " + (e && e.message || e));
    }
  } finally {
    pickerBusy = false;
  }
};

/* ---- Launch: build Module (all the boot wiring) and load blender.js. Gated on
 * the Launch button, which is enabled once both downloads finished above. The
 * WebGPU device itself is acquired on the render pthread (creator.cc bootstrap),
 * so we only sanity-check WebGPU availability here. ---- */
async function start() {
  /* WebGPU availability + software-renderer state were already probed and
   * surfaced (probeGpu / the Launch gate); a fatal GPU state keeps the button
   * disabled, so reaching here means we're clear to boot. */
  if (gpuStatus && gpuStatus.fatal) {
    console.error(gpuStatus.message.replace(/<[^>]+>/g, ""));
    return;
  }
  if (gpuStatus && gpuStatus.software) {
    console.warn("WebGPU is using a SOFTWARE renderer — Blender will be extremely slow.");
  }
  setUiPhase("console");
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";

window.Module = {
  arguments: ["--factory-startup", ...(window.__BARGS || [])],
  canvas,
  print: (t) => { log(t); scan(t); },
  printErr: (t) => { log("[err] " + t); scan(t); },
  instantiateWasm: (imports, cb) => {
    WebAssembly.instantiate(wasmBytes, imports).then((o) => cb(o.instance, o.module));
    return {};
  },
  preRun: [function () {
    try {
      ENV.BLENDER_WEB_OPFS = "1";
      ENV.HOME = "/opfs/home";
      /* Assets are mounted zero-copy at /assets (provider backend), not
       * extracted to OPFS. BLENDER_SYSTEM_RESOURCES holds scripts/ + datafiles/;
       * BLENDER_SYSTEM_PYTHON expects <dir>/lib/python3.13. */
      ENV.BLENDER_SYSTEM_RESOURCES = "/assets/5.3";
      ENV.BLENDER_SYSTEM_PYTHON = "/assets";
      ENV.PYTHONHOME = "/assets";
      if (window.__CAPENV) for (const k in window.__CAPENV) ENV[k] = window.__CAPENV[k];
    } catch (e) { log("preRun ENV: " + e); }

    /* Register the in-memory tar FsProvider for the WasmFS ProviderBackend
     * (demo/provider_backend.cpp + provider-fs.js). Its hooks run on the
     * runtime main thread and read Module.geckoProviders[mountId] here. The
     * mount itself is done in C (creator.cc) once the runtime is up, gated on
     * BLENDER_WEB_ASSET_PROVIDER — mirrors gecko's embed-init.cpp. mountId 0. */
    Module.geckoProviders = { 0: assetProvider };
    ENV.BLENDER_WEB_ASSET_PROVIDER = "1";

    addRunDependency("wgsl-cache");
    (async () => {
      const db = await idbOpen();
      const rows = await new Promise((res, rej) => {
        const rq = db.transaction("wgsl").objectStore("wgsl").getAll();
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      });
      let seed = [];
      try {
        const rsp = await fetch("wgsl-cache.json");
        if (rsp.ok) seed = await rsp.json();
      } catch (e) {}
      globalThis.__WGSL_CACHE__ = new Map([...seed, ...rows.map((r) => [r.key, r.wgsl])]);
      globalThis.__WGSL_CACHE_PUT__ = (k, v) => {
        try { db.transaction("wgsl", "readwrite").objectStore("wgsl").put({ key: k, wgsl: v }); }
        catch (e) {}
      };
    })().catch((e) => log("wgsl cache: " + e)).finally(() => removeRunDependency("wgsl-cache"));
  }],
  onRuntimeInitialized: () => {
    /* Parent of the local-folder mount points (wm_open_mainfile also creates
     * it wasm-side; this covers sessions where the dialog never opened). */
    try { window.Module.FS.mkdir(MOUNT_ROOT); } catch (e) { /* exists */ }
    /* Tell the wasm side whether the File System Access API is available, so
     * Save can pick a folder (Chromium) or fall back to a blob download
     * (Firefox/Safari). */
    try {
      window.Module.ccall("blender_web_set_has_fsaccess", null, ["number"],
                          [window.showDirectoryPicker ? 1 : 0]);
    } catch (e) { log("set_has_fsaccess: " + e); }
  },
  onAbort: (w) => { log("ABORT: " + w); status("Failed to start: " + w); },
};

  log("loading Blender…");
  const s = document.createElement("script");
  s.src = "blender.js";
  document.body.appendChild(s);
}

startBtn.onclick = () => { void start(); };
/* The button's enabled state is driven by refreshStartGate() (asset readiness +
 * GPU status + software-ack), not toggled unconditionally here. */
refreshStartGate();
