/* A persistent headless Blender in a dedicated worker (classic: the emscripten
 * glue is loaded with importScripts).
 *
 * Booted once with protocol.py (this package) in server mode; afterwards each
 * request is a file handed through the module FS and costs only its own work:
 * no module instantiation, no Python start, no .blend load or save unless the
 * request asks.
 *
 * in:  { type: "boot", runtimeUrl, flavor, wasmModule, dataPackage, server }
 *      { type: "request", id, request, files, blend? }
 *      { type: "api", id, method, args }  an embind call (bw_api.cc), between requests
 * out: { type: "phase", name, ms } (glueLoaded, instantiated, preRun, runtimeInitialized,
 *      firstLine, python) | { type: "ready", marks } | { type: "line", text }
 *      { type: "response", id, files, output } | { type: "fatal", message }
 *      { type: "api", id, result } | { type: "api", id, error }
 *
 * Response files are keyed as a one-shot run writes them (/out/report.json,
 * /out/geo/<id>.bin, /out/session.blend), so the page decodes both the same way.
 */
let FS = null;
/** The module, for its embind API (the factory's promise never settles: main() never returns). */
let blender = null;
const API = new Set(["bwVersion", "bwGet", "bwSet", "bwCall", "bwPython", "bwObjects", "bwMesh"]);

/* An embind call. Blender runs it on its own thread between requests: the
 * pthread build proxies it there (this thread waits), and in the
 * single-threaded build this handler only runs while Blender is suspended in
 * its poll loop. JSON results are parsed on the page; a mesh's arrays view wasm
 * memory, so they are copied out and transferred. */
function api({ id, method, args }) {
  try {
    if (!ready || !blender || !API.has(method)) throw new Error(`Blender API ${method} unavailable`);
    const result = blender[method](...args);
    if (method === "bwMesh" && result) {
      const copy = { vertexCount: result.vertexCount, groups: result.groups,
        positions: result.positions.slice(), normals: result.normals.slice(), uvs: result.uvs?.slice() };
      self.postMessage({ type: "api", id, result: copy }, [copy.positions.buffer, copy.normals.buffer, ...(copy.uvs ? [copy.uvs.buffer] : [])]);
      return;
    }
    self.postMessage({ type: "api", id, result });
  } catch (error) {
    self.postMessage({ type: "api", id, error: error instanceof Error ? error.message : String(error) });
  }
}
let ready = false;
const queue = [];
let current = null; // { id, lines }
/** Boot phase marks (ms since the boot message), reported with "ready". */
const marks = {};
let bootStart = 0;
const mark = (name) => {
  if (name in marks) return;
  marks[name] = Math.round(performance.now() - bootStart);
  self.postMessage({ type: "phase", name, ms: marks[name] });
};


/* Pthread workers must be same-origin. For a runtime on another origin (a
 * CDN), they start from a blob that imports the glue (emscripten#21937). */
function mainScript(runtimeUrl) {
  const url = runtimeUrl + "blender.js";
  if (new URL(url).origin === self.location.origin) return url;
  return new Blob([`importScripts(${JSON.stringify(url)});`], { type: "text/javascript" });
}
function mkdirp(dir) {
  let path = "";
  for (const part of dir.split("/").filter(Boolean)) {
    path += "/" + part;
    try { FS.mkdir(path); } catch { /* exists */ }
  }
}

function collect(dir, prefix, out) {
  let names = [];
  try { names = FS.readdir(dir).filter((n) => n !== "." && n !== ".."); } catch { return; }
  for (const name of names) {
    const full = `${dir}/${name}`;
    if (FS.isDir(FS.stat(full).mode)) {
      collect(full, `${prefix}/${name}`, out);
      FS.rmdir(full);
    } else {
      out[`${prefix}/${name}`] = FS.readFile(full);
      FS.unlink(full);
    }
  }
}

function removeTree(dir) {
  let names = [];
  try { names = FS.readdir(dir).filter((n) => n !== "." && n !== ".."); } catch { return; }
  for (const name of names) {
    const full = `${dir}/${name}`;
    if (FS.isDir(FS.stat(full).mode)) { removeTree(full); FS.rmdir(full); } else FS.unlink(full);
  }
}

function next() {
  if (!ready || current || queue.length === 0) return;
  const { id, request, files, blend } = queue.shift();
  current = { id, lines: [] };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirp(path.slice(0, path.lastIndexOf("/")));
    FS.writeFile(path, bytes);
  }
  if (blend) {
    FS.writeFile("/ipc/in.blend", blend);
    request.load = { kind: "blend", path: "/ipc/in.blend" };
  }
  // Written then renamed, so the server never reads a half-written request.
  FS.writeFile("/ipc/request.tmp", JSON.stringify({ id, ...request }));
  FS.rename("/ipc/request.tmp", "/ipc/request.json");
}

function finish(id) {
  if (!current || current.id !== id) return;
  const out = {};
  collect("/out", "/out", out);
  removeTree("/job");
  const output = current.lines.join("\n");
  current = null;
  self.postMessage({ type: "response", id, files: out, output }, Object.values(out).map((b) => b.buffer));
  next();
}

/** Blender's last lines, for a fatal report (output before ready has no request to go to). */
const recent = [];

function print(text) {
  recent.push(text);
  if (recent.length > 40) recent.shift();
  mark("firstLine");
  if (text.includes("<<<BW_PYTHON>>>")) {
    mark("python");
    return;
  }
  if (text.includes("<<<BW_READY>>>")) {
    mark("ready");
    ready = true;
    self.postMessage({ type: "ready", marks });
    next();
    return;
  }
  const done = text.match(/<<<BW_DONE (\S+)>>>/);
  if (done) {
    finish(done[1]);
    return;
  }
  if (current) current.lines.push(text);
  self.postMessage({ type: "line", text });
}

self.onmessage = ({ data }) => {
  if (data.type === "api") {
    api(data);
    return;
  }
  if (data.type === "request") {
    queue.push(data);
    next();
    return;
  }
  if (data.type !== "boot") return;
  const { runtimeUrl, flavor, wasmModule, dataPackage, server } = data;
  bootStart = performance.now();
  // A WebAssembly.Exception (a C++ exception or longjmp leaving main) stringifies
  // to nothing useful: report its stack, how far the boot got, and the last output.
  const fatal = (error) => {
    const detail = error instanceof Error ? error.stack || error.message
      : typeof WebAssembly.Exception === "function" && error instanceof WebAssembly.Exception ? `WebAssembly.Exception\n${error.stack ?? ""}`
      : String(error);
    const reached = Object.keys(marks).join(", ") || "none";
    self.postMessage({ type: "fatal", message: `${detail}\nboot phases reached: ${reached}\nlast output:\n${recent.slice(-15).join("\n")}` });
  };
  try {
    importScripts(runtimeUrl + "blender.js");
    mark("glueLoaded");
    // eslint-disable-next-line no-undef
    createBlenderModule({
      arguments: ["--background", "--factory-startup", "--python", "/ipc/server.py"],
      mainScriptUrlOrBlob: mainScript(runtimeUrl),
      locateFile: (path) => runtimeUrl + path,
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => { mark("instantiated"); done(instance, wasmModule); }, fatal);
        return {};
      },
      getPreloadedPackage: () => dataPackage,
      print,
      printErr: print,
      preRun: [(module) => {
        mark("preRun");
        FS = module.FS;
        blender = module;
        module.ENV.BLENDER_SYSTEM_RESOURCES = "/5.3";
        module.ENV.HOME = "/tmp";
        // Blender's main runs this between sleeps (bw_api's calls run there too);
        // in the single-threaded build the sleep is when this worker's messages run.
        module.ENV.BLENDER_WASM_POLL = "__bw_poll__()";
        mkdirp("/ipc");
        FS.writeFile("/ipc/server.py", 'print("<<<BW_PYTHON>>>", flush=True)\nBW_SERVER = True\n' + server);
      }],
      onRuntimeInitialized: () => mark("runtimeInitialized"),
      onAbort: (what) => fatal(`Blender aborted: ${what}`),
    }).catch(fatal);
  } catch (error) {
    fatal(error);
  }
};
