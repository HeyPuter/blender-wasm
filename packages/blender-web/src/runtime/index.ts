/**
 * Puts the browser runtime where pages are served (Node, build time).
 *
 * The binaries ship in this package's runtime/ directory, brotli-compressed,
 * in two flavours: `mt` (pthreads; needs a cross-origin isolated page) and
 * `st` (single-threaded with JSPI; any page). A served runtime directory is:
 *
 *   <flavour>/blender.js         emscripten glue, unmodified (pthread workers load it)
 *   <flavour>/blender.wasm       inflated, for servers that do not negotiate encodings
 *   <flavour>/blender.data       inflated
 *   <flavour>/blender.wasm.br    the same bytes for `Content-Encoding: br` (optional)
 *   <flavour>/blender.data.br
 *   <flavour>/manifest.json      that flavour's build and file digests
 *   session-worker.js            this package's workers (classic: they importScripts
 *   run-worker.js                the glue)
 *   LICENSE, THIRD-PARTY-LICENSES.md
 *   manifest.json                { forkRevision, flavors: { mt?, st? } }, written
 *                                last: its presence means the copy is complete
 *
 * Every file is checked against its flavour manifest's sha256.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The runtime shipped in this package (dist/runtime/ -> runtime/). */
export const PACKAGED_RUNTIME = resolve(HERE, "../../runtime");
const WORKERS = ["session-worker.js", "run-worker.js"];
export const FLAVORS = ["mt", "st"] as const;
export type Flavor = (typeof FLAVORS)[number];

interface FileDigest { bytes: number; sha256: string }
export interface FlavorManifest {
  flavor: string;
  forkRevision: string;
  blenderRevision?: string;
  emsdk?: string;
  wasmOpt: string;
  files: Record<string, FileDigest>;
  raw: Record<string, FileDigest>;
}
export interface RuntimePackageManifest {
  forkRevision: string;
  flavors: Partial<Record<Flavor, FlavorManifest>>;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The runtime directory to install from: `runtimeDir`, else the one in this package. */
export function resolveRuntimeDir(options: { runtimeDir?: string } = {}): string {
  const dir = options.runtimeDir ? resolve(options.runtimeDir) : PACKAGED_RUNTIME;
  if (!FLAVORS.some((f) => existsSync(join(dir, f, "manifest.json")))) {
    throw new Error(`no Blender runtime in ${dir}${options.runtimeDir ? "" : " (a source checkout: run ./build.sh browser and/or browser-st, then npm run build)"}`);
  }
  return dir;
}

/** The flavours a runtime directory holds, with their manifests. */
export function readRuntimeManifest(runtimeDir: string): RuntimePackageManifest {
  const flavors: Partial<Record<Flavor, FlavorManifest>> = {};
  for (const flavor of FLAVORS) {
    const path = join(runtimeDir, flavor, "manifest.json");
    if (existsSync(path)) flavors[flavor] = JSON.parse(readFileSync(path, "utf8"));
  }
  const any = Object.values(flavors)[0];
  return { forkRevision: any?.forkRevision ?? "unknown", flavors };
}

export interface InstallOptions {
  /** The directory to fill (e.g. public/blender-runtime). */
  dest: string;
  /** A runtime directory other than the packaged one. */
  runtimeDir?: string;
  /** Also write the .br files, for servers that send them with Content-Encoding (default true). */
  compressed?: boolean;
  log?: (line: string) => void;
}

/** Fills `dest` with a servable runtime; skips when it already holds this one. */
export function installRuntime(options: InstallOptions): { dest: string; manifest: RuntimePackageManifest; skipped: boolean } {
  const runtimeDir = resolveRuntimeDir(options);
  const manifest = readRuntimeManifest(runtimeDir);
  const dest = resolve(options.dest);
  const compressed = options.compressed ?? true;
  const workerSources = WORKERS.map((name) => join(HERE, "../browser", name));
  const stamp = JSON.stringify({ ...manifest, workers: workerSources.map((p) => sha256(readFileSync(p))), compressed });
  const stampPath = join(dest, ".blender-web-stamp");
  const complete = existsSync(join(dest, "manifest.json")) && existsSync(stampPath)
    && readFileSync(stampPath, "utf8") === stamp
    && Object.entries(manifest.flavors).every(([flavor, m]) => Object.entries(m.raw)
      .every(([name, d]) => existsSync(join(dest, flavor, name)) && statSync(join(dest, flavor, name)).size === d.bytes));
  if (complete) return { dest, manifest, skipped: true };

  const write = (name: string, data: Uint8Array): void => {
    // Written aside then renamed, so a server never sends a half-written file.
    mkdirSync(dirname(join(dest, name)), { recursive: true });
    writeFileSync(join(dest, `${name}.tmp`), data);
    renameSync(join(dest, `${name}.tmp`), join(dest, name));
  };
  for (const [flavor, m] of Object.entries(manifest.flavors)) {
    const read = (name: string): Buffer => {
      const data = readFileSync(join(runtimeDir, flavor, name));
      const expected = m.files[name];
      if (expected && sha256(data) !== expected.sha256) throw new Error(`${flavor}/${name} in ${runtimeDir} does not match its manifest`);
      return data;
    };
    for (const [name, expected] of Object.entries(m.raw)) {
      const packed = read(`${name}.br`);
      const data = brotliDecompressSync(packed);
      if (sha256(data) !== expected.sha256) throw new Error(`${flavor}/${name}.br inflates to the wrong bytes`);
      write(`${flavor}/${name}`, data);
      if (compressed) write(`${flavor}/${name}.br`, packed);
      options.log?.(`${flavor}/${name}: ${(data.byteLength / 1048576).toFixed(1)} MB${compressed ? ` (+ .br ${(packed.byteLength / 1048576).toFixed(1)} MB)` : ""}`);
    }
    write(`${flavor}/blender.js`, read("blender.js"));
    write(`${flavor}/manifest.json`, readFileSync(join(runtimeDir, flavor, "manifest.json")));
  }
  WORKERS.forEach((name, i) => write(name, readFileSync(workerSources[i])));
  // The package's license and notices travel with the served binaries.
  for (const name of ["LICENSE", "THIRD-PARTY-LICENSES.md"]) {
    const path = join(HERE, "../..", name);
    if (existsSync(path)) write(name, readFileSync(path));
  }
  write("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  writeFileSync(stampPath, stamp);
  return { dest, manifest, skipped: false };
}

/** Content types a runtime directory needs (compileStreaming insists on application/wasm). */
export const RUNTIME_CONTENT_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".js": "text/javascript",
  ".json": "application/json",
};

/** Headers that make a page cross-origin isolated (SharedArrayBuffer, so pthreads). */
export const CROSS_ORIGIN_ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;
