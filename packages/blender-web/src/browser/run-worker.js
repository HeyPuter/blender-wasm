/* One headless Blender run inside a dedicated worker (a classic worker: the
 * emscripten glue is loaded with importScripts).
 *
 * The page compiles blender.wasm once and fetches blender.data once, then hands
 * both to a fresh worker per run: main() never returns, so a module instance
 * is good for exactly one run, and terminating the worker reclaims it and its
 * pthreads.
 *
 * in:  { runtimeUrl, wasmModule, dataPackage, args, files, collect, marker }
 * out: { type: "line", text } ... then { type: "done", output, files } | { type: "error", message, output }
 */
/* Pthread workers must be same-origin. For a runtime on another origin (a
 * CDN), they start from a blob that imports the glue (emscripten#21937). */
function mainScript(runtimeUrl) {
  const url = runtimeUrl + "blender.js";
  if (new URL(url).origin === self.location.origin) return url;
  return new Blob([`importScripts(${JSON.stringify(url)});`], { type: "text/javascript" });
}

self.onmessage = (event) => {
  const { runtimeUrl, wasmModule, dataPackage, args, files, collect, marker } = event.data;
  const lines = [];
  let moduleRef;
  let settled = false;

  const mkdirp = (FS, dir) => {
    let current = "";
    for (const part of dir.split("/").filter(Boolean)) {
      current += "/" + part;
      try { FS.mkdir(current); } catch { /* exists */ }
    }
  };
  const harvest = (FS, dir, out) => {
    let names = [];
    try { names = FS.readdir(dir).filter((n) => n !== "." && n !== ".."); } catch { return; }
    for (const name of names) {
      const full = `${dir}/${name}`;
      try {
        if (FS.isDir(FS.stat(full).mode)) harvest(FS, full, out);
        else out[full] = FS.readFile(full);
      } catch { /* unreadable entries are skipped */ }
    }
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    const out = {};
    if (moduleRef) harvest(moduleRef.FS, collect, out);
    self.postMessage({ type: "done", output: lines.join("\n"), files: out },
      Object.values(out).map((bytes) => bytes.buffer));
  };
  const fail = (message) => !settled && (settled = true) && self.postMessage({ type: "error", message: String(message), output: lines.join("\n") });
  const print = (text) => {
    lines.push(text);
    self.postMessage({ type: "line", text });
    if (text.includes(marker)) finish();
  };

  try {
    importScripts(runtimeUrl + "blender.js");
    // eslint-disable-next-line no-undef
    createBlenderModule({
      arguments: args,
      // pthread workers load the glue by this URL, not by this worker's.
      mainScriptUrlOrBlob: mainScript(runtimeUrl),
      locateFile: (path) => runtimeUrl + path,
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance, wasmModule), fail);
        return {};
      },
      getPreloadedPackage: () => dataPackage,
      print,
      printErr: print,
      preRun: [(module) => {
        moduleRef = module;
        module.ENV.BLENDER_SYSTEM_RESOURCES = "/5.3";
        module.ENV.HOME = "/tmp";
        for (const [path, bytes] of Object.entries(files)) {
          mkdirp(module.FS, path.slice(0, path.lastIndexOf("/")));
          module.FS.writeFile(path, bytes);
        }
        mkdirp(module.FS, collect);
      }],
      onAbort: (what) => fail(`Blender aborted: ${what}`),
    }).catch(fail);
  } catch (error) {
    fail(error && error.stack || error);
  }
};
