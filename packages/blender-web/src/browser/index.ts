/**
 * Blender in the browser: a persistent session (one worker, booted once) and
 * a one-shot runner (a worker per run).
 *
 * Both load a served runtime directory (`runtimeUrl`, default
 * `blender-runtime/` under the page's base) as the Vite plugin
 * (`@knervous/blender-web/vite`) or `blender-web install <dir>` lay it out:
 * a manifest, this package's workers, and a directory per flavour.
 *
 *   mt  pthreads. Needs a cross-origin isolated page (COOP same-origin + COEP
 *       require-corp): the threads need SharedArrayBuffer.
 *   st  single-threaded, with JSPI: Blender runs on the worker's own thread
 *       and hands it back between requests. Any page.
 *
 * `threads: "auto"` (the default) takes mt where the page is isolated and st
 * everywhere else.
 */
import type {
  BlenderApi, BlenderJob, BlenderObjectInfo, BlenderRunner, BlenderSession, MeshData, OperatorResult, RnaInput, RnaValue,
} from "../project/index.ts";
import { PROTOCOL_SOURCE } from "../project/protocol.generated.ts";
import { loadBrotliDecoder, type BrotliDecoder } from "./brotli.ts";

export type Flavor = "mt" | "st";

export interface FlavorManifest {
  forkRevision: string;
  blenderRevision?: string;
  wasmOpt: string;
  /** Inflated sizes, so progress is right when the server sends brotli. */
  raw?: Record<string, { bytes: number; sha256: string }>;
}

export interface RuntimeManifest {
  forkRevision: string;
  /**
   * "br" when the binaries are served only as `.br` files (the package's own
   * runtime/ on a CDN): the page decodes them with brotli-decode.wasm.
   * Absent for an installed runtime, which has the raw files.
   */
  encoding?: "br";
  flavors: Partial<Record<Flavor, FlavorManifest>>;
}

/** Which build to run: "auto" takes mt on a cross-origin isolated page and st elsewhere. */
export type ThreadsOption = "auto" | boolean;

/** Where the Vite plugin and `blender-web install` put the runtime, relative to the page. */
export const DEFAULT_RUNTIME_URL = "blender-runtime/";

/** The pthread build needs SharedArrayBuffer, which only a cross-origin isolated page has. */
export class NotIsolatedError extends Error {
  constructor() {
    super("This page is not cross-origin isolated, so the pthread build of Blender cannot start. Serve it "
      + "with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp "
      + "(the Vite plugin does), or use `threads: \"auto\"` / `false` for the single-threaded build.");
  }
}

/** The flavour `threads` asks for, given the page and what the runtime directory holds. */
export function pickFlavor(manifest: RuntimeManifest, threads: ThreadsOption = "auto"): Flavor {
  const wanted: Flavor = threads === "auto" ? (isolated() && manifest.flavors.mt ? "mt" : "st") : threads ? "mt" : "st";
  if (wanted === "mt" && !isolated()) throw new NotIsolatedError();
  if (!manifest.flavors[wanted]) {
    const has = Object.keys(manifest.flavors).join(", ") || "none";
    throw new Error(`The runtime has no ${wanted === "mt" ? "pthread (mt)" : "single-threaded (st)"} build (it has: ${has})`);
  }
  return wanted;
}

const isolated = (): boolean => typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false;

/** The runtime's manifest.json, or null when nothing is served at `runtimeUrl`. */
export async function runtimeInstalled(runtimeUrl: string | URL = DEFAULT_RUNTIME_URL): Promise<RuntimeManifest | null> {
  try {
    const response = await fetch(new URL("manifest.json", directory(runtimeUrl)), { cache: "no-store" });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- progress */
export type BootPhase = "download" | "compile" | "start" | "ready";

export interface BootProgress {
  phase: BootPhase;
  /** 0..1 across the whole boot, monotonic. */
  fraction: number;
  /** Bytes downloaded so far and in total (download phase; total may be 0 if unknown). */
  loaded: number;
  total: number;
  /** A human-readable step, e.g. "starting Python". */
  detail: string;
}

/* Boot weights from a measured profile (quiet machine, precompiled .pyc):
 * download + compile take the first half; Blender's start is split by the
 * worker's phase marks. Rough by design, monotonic always. */
const START_STEPS: Record<string, [number, string]> = {
  glueLoaded: [0.52, "loading Blender"],
  instantiated: [0.55, "instantiating"],
  preRun: [0.6, "mounting files"],
  runtimeInitialized: [0.7, "starting Blender"],
  firstLine: [0.72, "starting Blender"],
  python: [0.9, "starting Python"],
};

async function fetchCounted(url: string, size: number | undefined, onBytes: (delta: number, total: number) => void,
  decoder: BrotliDecoder | null): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  // The body arrives inflated; Content-Length is the encoded size when the
  // server compressed it, so prefer the manifest's raw size.
  const encoded = Boolean(response.headers.get("content-encoding"));
  const total = size ?? (encoded ? 0 : Number(response.headers.get("content-length") ?? 0));
  // A .br file is brotli whatever the transport: a CDN may compress it again
  // (jsDelivr answers with Content-Encoding: br), and the browser removes
  // only that layer. So a requested .br is always decoded here.
  const body = decoder ? response.body.pipeThrough(decoder()) : response.body;
  const reader = body.getReader();
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      onBytes(value.byteLength, total);
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(counted, { headers: { "content-type": response.headers.get("content-type") ?? "" } });
}

/**
 * Fetch one flavour's blender.wasm (compiling while it streams) and
 * blender.data, reporting bytes. Returns the flavour's directory URL too.
 */
async function loadRuntime(runtimeUrl: string, threads: ThreadsOption, report: (p: BootProgress) => void) {
  const runtime = await runtimeInstalled(runtimeUrl);
  if (!runtime) throw new Error(`No Blender runtime at ${runtimeUrl} (manifest.json missing)`);
  const flavor = pickFlavor(runtime, threads);
  const manifest: Partial<FlavorManifest> = runtime.flavors[flavor] ?? {};
  const flavorUrl = `${runtimeUrl}${flavor}/`;
  const decoder = runtime.encoding === "br" ? await loadBrotliDecoder(`${runtimeUrl}brotli-decode.wasm`) : null;
  const suffix = decoder ? ".br" : "";
  const totals = { wasm: 0, data: 0 };
  const loaded = { wasm: 0, data: 0 };
  const emit = () => {
    const total = totals.wasm + totals.data;
    const sum = loaded.wasm + loaded.data;
    report({ phase: "download", fraction: total ? 0.45 * Math.min(1, sum / total) : 0, loaded: sum, total, detail: "downloading Blender" });
  };
  const count = (key: "wasm" | "data") => (delta: number, total: number) => {
    totals[key] = total;
    loaded[key] += delta;
    emit();
  };
  const wasm = fetchCounted(`${flavorUrl}blender.wasm${suffix}`, manifest.raw?.["blender.wasm"]?.bytes, count("wasm"), decoder).then((response) => {
    // compileStreaming needs the wasm media type on the (re-wrapped) response.
    const typed = new Response(response.body, { headers: { "content-type": "application/wasm" } });
    return WebAssembly.compileStreaming(typed);
  });
  const data = fetchCounted(`${flavorUrl}blender.data${suffix}`, manifest.raw?.["blender.data"]?.bytes, count("data"), decoder).then((r) => r.arrayBuffer());
  const [wasmModule, dataPackage] = await Promise.all([wasm, data]);
  report({ phase: "compile", fraction: 0.5, loaded: loaded.wasm + loaded.data, total: totals.wasm + totals.data, detail: "compiled" });
  return { wasmModule, dataPackage, flavor, flavorUrl };
}

/* ----------------------------------------------------------------- session */
export interface BlenderSessionOptions {
  /** The served runtime directory (default `blender-runtime/` under the page's base). */
  runtimeUrl?: string | URL;
  /** The session worker script (default: session-worker.js in the runtime directory). */
  workerUrl?: string | URL;
  /** Which build to run (default "auto": pthreads where the page is isolated, else single-threaded). */
  threads?: ThreadsOption;
  /** protocol.py source; defaults to the one shipped with this package. */
  server?: string;
  onProgress?: (progress: BootProgress) => void;
}

export interface BrowserBlenderSession extends BlenderSession {
  /** Boots once (idempotent); requests boot on demand too. */
  boot(): Promise<void>;
  /** Total boot ms, the download+compile share, and Blender's own start. */
  readonly bootMs: number;
  readonly compileMs: number;
  readonly startMs: number;
  /** Worker phase marks, ms since it received the boot message. */
  readonly phases: Record<string, number>;
  /** The build that booted (after boot). */
  readonly flavor: Flavor | null;
  /** Blender's direct API (embind); calls boot the session if needed. */
  readonly api: BlenderApi;
  /** Ends the worker (and Blender); the next request boots a new one. */
  close(): void;
}

/** RPC names of the worker's embind calls (bw_api.cc). */
type ApiMethod = "bwGet" | "bwSet" | "bwCall" | "bwPython" | "bwObjects" | "bwMesh";

/** Operator idnames in either spelling: "mesh.primitive_cube_add" -> "MESH_OT_primitive_cube_add". */
const operatorIdname = (name: string): string => {
  const dot = name.indexOf(".");
  return dot > 0 && !name.includes("_OT_") ? `${name.slice(0, dot).toUpperCase()}_OT_${name.slice(dot + 1)}` : name;
};

const isMeshData = (value: unknown): value is MeshData =>
  typeof value === "object" && value !== null && "vertexCount" in value && "positions" in value;

/**
 * A worker from the runtime directory. Deliberately not the bundler pattern
 * (`new Worker(new URL(..., import.meta.url))`): the workers and the glue
 * they import must load unmodified, and a bundled worker cannot find the
 * glue its pthreads load. Workers must be same-origin, so one from another
 * origin (a CDN) starts from a blob that imports it.
 */
function startWorker(url: string): Worker {
  const page = typeof document === "undefined" ? self.location.href : document.baseURI;
  if (new URL(url, page).origin === new URL(page).origin) return new Worker(url);
  const trampoline = new Blob([`importScripts(${JSON.stringify(url)});`], { type: "text/javascript" });
  return new Worker(URL.createObjectURL(trampoline));
}

const directory = (url: string | URL): string => {
  const href = new URL(url, typeof document === "undefined" ? self.location.href : document.baseURI).href;
  return href.endsWith("/") ? href : href + "/";
};

/**
 * A persistent Blender in one worker, booted once with the project protocol
 * in server mode. Requests then cost only their own work. If the worker dies
 * (an abort), pending requests reject and the next request boots a new one;
 * the session scene is lost with it, so reopen the .blend.
 */
export function createBlenderSession(options: BlenderSessionOptions = {}): BrowserBlenderSession {
  const runtimeUrl = directory(options.runtimeUrl ?? DEFAULT_RUNTIME_URL);
  const server = options.server ?? PROTOCOL_SOURCE;
  const report = options.onProgress ?? (() => {});
  type Pending = {
    resolve: (r: { output: string; files: Record<string, Uint8Array> }) => void;
    reject: (e: Error) => void;
    onLine?: (line: string) => void;
  };
  let worker: Worker | null = null;
  let booting: Promise<void> | null = null;
  const pending = new Map<string, Pending>();
  let nextId = 0;
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextCall = 0;
  const rpc = async (method: ApiMethod, ...args: unknown[]): Promise<unknown> => {
    await session.boot();
    const id = ++nextCall;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      worker?.postMessage({ type: "api", id, method, args });
    });
  };
  const json = async (method: ApiMethod, ...args: unknown[]): Promise<unknown> => {
    const text = await rpc(method, ...args);
    return typeof text === "string" ? JSON.parse(text) : null;
  };
  const api: BlenderApi = {
    get: async (path) => {
      const value = await json("bwGet", path);
      return isRnaValue(value) ? value : null;
    },
    set: async (path, value: RnaInput) => (await rpc("bwSet", path, value)) === true,
    call: async (operator, props = {}) => {
      const result = await rpc("bwCall", operatorIdname(operator), props);
      return isOperatorResult(result) ? result : "NOT_FOUND";
    },
    python: async (code) => (await rpc("bwPython", code)) === true,
    objects: async () => {
      const list = await json("bwObjects");
      return Array.isArray(list) ? list.filter(isObjectInfo) : [];
    },
    mesh: async (idOrName) => {
      const mesh = await rpc("bwMesh", idOrName);
      return isMeshData(mesh) ? mesh : null;
    },
  };
  let current: string | null = null;
  let fraction = 0;
  const progress = (p: BootProgress): void => {
    fraction = Math.max(fraction, p.fraction);
    report({ ...p, fraction });
  };

  const fail = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    for (const call of calls.values()) call.reject(error);
    calls.clear();
    current = null;
    worker?.terminate();
    worker = null;
    booting = null;
  };

  const session: BrowserBlenderSession & { bootMs: number; compileMs: number; startMs: number; phases: Record<string, number>; flavor: Flavor | null } = {
    flavor: null,
    api,
    bootMs: 0,
    compileMs: 0,
    startMs: 0,
    phases: {},
    boot(): Promise<void> {
      booting ??= (async () => {
        const started = performance.now();
        fraction = 0;
        const { wasmModule, dataPackage, flavor, flavorUrl } = await loadRuntime(runtimeUrl, options.threads ?? "auto", progress);
        session.flavor = flavor;
        session.compileMs = performance.now() - started;
        const w = startWorker(String(options.workerUrl ?? runtimeUrl + "session-worker.js"));
        worker = w;
        await new Promise<void>((resolve, reject) => {
          w.onerror = (event) => { const error = new Error(event.message || "Blender worker failed"); fail(error); reject(error); };
          w.onmessage = ({ data }) => {
            if (data.type === "phase") {
              const step = START_STEPS[data.name];
              if (step) progress({ phase: "start", fraction: step[0], loaded: 0, total: 0, detail: step[1] });
            } else if (data.type === "ready") {
              session.bootMs = performance.now() - started;
              session.startMs = session.bootMs - session.compileMs;
              session.phases = data.marks ?? {};
              progress({ phase: "ready", fraction: 1, loaded: 0, total: 0, detail: "ready" });
              resolve();
            } else if (data.type === "line") {
              if (current) pending.get(current)?.onLine?.(data.text);
            } else if (data.type === "response") {
              const entry = pending.get(data.id);
              pending.delete(data.id);
              current = pending.keys().next().value ?? null;
              entry?.resolve({ output: data.output, files: data.files });
            } else if (data.type === "api") {
              const call = calls.get(data.id);
              calls.delete(data.id);
              if (data.error) call?.reject(new Error(data.error));
              else call?.resolve(data.result);
            } else if (data.type === "fatal") {
              const error = new Error(data.message);
              fail(error);
              reject(error);
            }
          };
          w.postMessage({ type: "boot", runtimeUrl: flavorUrl, flavor, wasmModule, dataPackage, server }, [dataPackage]);
        });
      })().catch((error: unknown) => {
        // A failed boot (no runtime, not isolated, an abort) is retried by the next call.
        booting = null;
        throw error;
      });
      return booting;
    },
    async request(request: {
      job: BlenderJob;
      files: Record<string, Uint8Array>;
      load?: { kind: "factory" | "empty" } | { kind: "blend"; bytes: Uint8Array };
      save?: boolean;
      onLine?: (line: string) => void;
    }): Promise<{ output: string; files: Record<string, Uint8Array> }> {
      await session.boot();
      const id = String(++nextId);
      const blend = request.load?.kind === "blend" ? request.load.bytes : undefined;
      const load = request.load && request.load.kind !== "blend" ? request.load : undefined;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onLine: request.onLine });
        current ??= id;
        worker?.postMessage({
          type: "request",
          id,
          request: { job: request.job, save: Boolean(request.save), ...(load ? { load } : {}) },
          files: request.files,
          blend,
        });
      });
    },
    close(): void {
      fail(new Error("Blender session closed"));
    },
  };
  return session;
}

const isRnaValue = (value: unknown): value is RnaValue =>
  value === null || ["number", "boolean", "string"].includes(typeof value)
  || (Array.isArray(value) && value.every((v) => typeof v === "number" || typeof v === "boolean"));

const isOperatorResult = (value: unknown): value is OperatorResult =>
  value === "FINISHED" || value === "CANCELLED" || value === "PASS_THROUGH" || value === "NOT_FOUND";

const KINDS = new Set(["mesh", "empty", "light", "camera", "other"]);
const isObjectInfo = (value: unknown): value is BlenderObjectInfo =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  && "kind" in value && typeof value.kind === "string" && KINDS.has(value.kind);

/* ------------------------------------------------------------- one-shot runner */
const ERROR_MARKER = "<<<BLENDER_PYTHON_ERROR>>>";
export const COMPLETION_MARKER = "<<<BLENDER_RUN_COMPLETE>>>";
const WRAPPER = [
  "import sys, traceback",
  "try:",
  "    exec(compile(open('/job/user.py').read(), '<job>', 'exec'), {'__name__': '__main__'})",
  "except BaseException:",
  `    print(${JSON.stringify(ERROR_MARKER)})`,
  "    traceback.print_exc(file=sys.stdout)",
  "finally:",
  `    print(${JSON.stringify(COMPLETION_MARKER)}, flush=True)`,
  "",
].join("\n");

/** A Python error inside a one-shot run. */
export class BlenderPythonError extends Error {
  constructor(readonly traceback: string, readonly output: string) {
    super(traceback.trim().split("\n").at(-1) ?? "Blender Python error");
  }
}

export interface BlenderRunnerOptions {
  runtimeUrl?: string | URL;
  threads?: ThreadsOption;
  workerUrl?: string | URL;
  onProgress?: (progress: BootProgress) => void;
}

/**
 * One Blender run per call, each in a fresh worker fed a once-compiled
 * module. Slow per call (Blender starts every time); prefer a session.
 */
export function createBlenderRunner(options: BlenderRunnerOptions = {}): BlenderRunner {
  const runtimeUrl = directory(options.runtimeUrl ?? DEFAULT_RUNTIME_URL);
  const encoder = new TextEncoder();
  let assets: ReturnType<typeof loadRuntime> | undefined;
  return {
    async run({ code, blendFile, files, onLine = () => {} }) {
      assets ??= loadRuntime(runtimeUrl, options.threads ?? "auto", options.onProgress ?? (() => {}));
      const { wasmModule, dataPackage, flavorUrl } = await assets;
      const staged = { ...files, "/job/main.py": encoder.encode(WRAPPER), "/job/user.py": encoder.encode(code) };
      const worker = startWorker(String(options.workerUrl ?? runtimeUrl + "run-worker.js"));
      try {
        const result = await new Promise<{ output: string; files: Record<string, Uint8Array> }>((resolve, reject) => {
          worker.onerror = (event) => reject(new Error(event.message || "Blender worker failed"));
          worker.onmessage = ({ data }) => {
            if (data.type === "line") onLine(data.text);
            else if (data.type === "done") resolve(data);
            else if (data.type === "error") reject(Object.assign(new Error(data.message), { output: data.output }));
          };
          worker.postMessage({
            runtimeUrl: flavorUrl,
            wasmModule,
            // The run's module consumes its copy; keep the original for the next run.
            dataPackage: dataPackage.slice(0),
            args: ["--background", "--factory-startup", ...(blendFile ? [blendFile] : []), "--python", "/job/main.py"],
            files: staged,
            collect: "/out",
            marker: COMPLETION_MARKER,
          });
        });
        const at = result.output.indexOf(ERROR_MARKER);
        if (at >= 0) {
          throw new BlenderPythonError(result.output.slice(at + ERROR_MARKER.length, result.output.indexOf(COMPLETION_MARKER, at)), result.output);
        }
        return { output: result.output, files: result.files };
      } finally {
        worker.terminate();
      }
    },
  };
}
