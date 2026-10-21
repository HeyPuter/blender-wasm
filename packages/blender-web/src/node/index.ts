/**
 * Blender in Node: a persistent in-process session (booted once) and a
 * one-shot runner (a child process per run). Both use the Node runtime
 * (blender.js + blender.wasm + blender.data, or their .zst copies) built by
 * `./build.sh node` (dist/blender-wasm-node).
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import type { BlenderJob, BlenderRunner, BlenderSession } from "../project/index.ts";
import { PROTOCOL_SOURCE } from "../project/protocol.generated.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

export const COMPLETION_MARKER = "<<<BLENDER_RUN_COMPLETE>>>";
export const ERROR_MARKER = "<<<BLENDER_PYTHON_ERROR>>>";

/** Makes sure blender.wasm and blender.data exist uncompressed in `runtimeDir`. */
export async function ensureRuntime(runtimeDir: string): Promise<string> {
  if (!existsSync(join(runtimeDir, "blender.js"))) throw new Error(`blender.js not found in ${runtimeDir}`);
  for (const name of ["blender.wasm", "blender.data"]) {
    const plain = join(runtimeDir, name);
    const packed = `${plain}.zst`;
    const stale = existsSync(packed) && (!existsSync(plain) || statSync(plain).mtimeMs < statSync(packed).mtimeMs);
    if (stale) await writeFile(plain, zlib.zstdDecompressSync(await readFile(packed)));
    if (!existsSync(plain)) throw new Error(`${name} not found in ${runtimeDir}`);
  }
  return runtimeDir;
}

type Files = Record<string, Uint8Array>;

/* ----------------------------------------------------------------- session */
export interface NodeSessionOptions {
  runtimeDir: string;
  /** protocol.py source; defaults to the one shipped with this package. */
  server?: string;
  initialMemoryMb?: number;
  onLine?: (line: string) => void;
}

export interface NodeBlenderSession extends BlenderSession {
  readonly bootMs: number;
  /**
   * Stops serving. Blender's pthreads keep a Node process alive (main() never
   * returns), so end the process with process.exit() when done.
   */
  close(): void;
}

interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
}
interface EmscriptenModule {
  FS: EmscriptenFS;
  ENV: Record<string, string>;
  PThread?: { terminateAllThreads(): void };
}
type ModuleFactory = (config: Record<string, unknown>) => Promise<EmscriptenModule>;

function isFactory(value: unknown): value is ModuleFactory {
  return typeof value === "function";
}

/**
 * A persistent Blender in this process, booted once with the project
 * protocol in server mode; requests cost only their own work.
 */
export async function createNodeSession(options: NodeSessionOptions): Promise<NodeBlenderSession> {
  const runtimeDir = await ensureRuntime(options.runtimeDir);
  const factory: unknown = createRequire(import.meta.url)(join(runtimeDir, "blender.js"));
  if (!isFactory(factory)) throw new Error(`${runtimeDir}/blender.js does not export a module factory`);
  const started = performance.now();
  let module: EmscriptenModule | null = null;
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const booted = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const waiting = new Map<string, () => void>();
  let lines: string[] = [];

  const print = (text: string): void => {
    if (text.includes("<<<BW_READY>>>")) { ready(); return; }
    const done = text.match(/<<<BW_DONE (\S+)>>>/);
    if (done) { waiting.get(done[1])?.(); return; }
    lines.push(text);
    options.onLine?.(text);
  };
  const mkdirp = (fs: EmscriptenFS, dir: string): void => {
    let path = "";
    for (const part of dir.split("/").filter(Boolean)) {
      path += "/" + part;
      try { fs.mkdir(path); } catch { /* exists */ }
    }
  };
  void factory({
    INITIAL_MEMORY: (options.initialMemoryMb ?? 256) * 1024 * 1024,
    arguments: ["--background", "--factory-startup", "--python", "/ipc/server.py"],
    locateFile: (path: string) => join(runtimeDir, path),
    print,
    printErr: print,
    preRun: [(m: EmscriptenModule) => {
      module = m;
      m.ENV.BLENDER_SYSTEM_RESOURCES = "/5.3";
      m.ENV.HOME = "/tmp";
      mkdirp(m.FS, "/ipc");
      m.FS.writeFile("/ipc/server.py", "BW_SERVER = True\n" + (options.server ?? PROTOCOL_SOURCE));
    }],
    onAbort: (what: unknown) => failed(new Error(`Blender aborted: ${String(what)}`)),
  }).catch((error: unknown) => failed(error instanceof Error ? error : new Error(String(error))));
  await booted;
  const bootMs = performance.now() - started;

  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  const collect = (fs: EmscriptenFS, dir: string, prefix: string, out: Files): void => {
    let names: string[] = [];
    try { names = fs.readdir(dir).filter((n) => n !== "." && n !== ".."); } catch { return; }
    for (const name of names) {
      const full = `${dir}/${name}`;
      if (fs.isDir(fs.stat(full).mode)) { collect(fs, full, `${prefix}/${name}`, out); fs.rmdir(full); }
      else { out[`${prefix}/${name}`] = fs.readFile(full); fs.unlink(full); }
    }
  };

  return {
    bootMs,
    request(request: {
      job: BlenderJob;
      files: Files;
      load?: { kind: "factory" | "empty" } | { kind: "blend"; bytes: Uint8Array };
      save?: boolean;
      onLine?: (line: string) => void;
    }) {
      const task = async (): Promise<{ output: string; files: Files }> => {
        const fs = module?.FS;
        if (!fs) throw new Error("Blender session is not running");
        const id = String(++nextId);
        for (const [path, bytes] of Object.entries(request.files)) {
          mkdirp(fs, path.slice(0, path.lastIndexOf("/")));
          fs.writeFile(path, bytes);
        }
        let load: unknown = undefined;
        if (request.load?.kind === "blend") {
          fs.writeFile("/ipc/in.blend", request.load.bytes);
          load = { kind: "blend", path: "/ipc/in.blend" };
        } else if (request.load) {
          load = request.load;
        }
        lines = [];
        const done = new Promise<void>((resolve) => waiting.set(id, resolve));
        fs.writeFile("/ipc/request.tmp", JSON.stringify({ id, job: request.job, save: Boolean(request.save), load }));
        fs.rename("/ipc/request.tmp", "/ipc/request.json");
        await done;
        waiting.delete(id);
        const files: Files = {};
        collect(fs, "/out", "/out", files);
        for (const line of lines) request.onLine?.(line);
        return { output: lines.join("\n"), files };
      };
      const next = queue.then(task);
      queue = next.catch(() => undefined);
      return next;
    },
    close(): void {
      // PThread is only reachable when the runtime exports it; an assertions
      // build throws on the missing getter. Blender's threads then stay alive,
      // so a Node process should end with process.exit() once it is done.
      try { module?.PThread?.terminateAllThreads(); } catch { /* not exported */ }
      module = null;
    },
  };
}

/* ------------------------------------------------------------- one-shot runner */
export interface NodeRunnerOptions {
  runtimeDir: string;
  initialMemoryMb?: number;
  timeoutMs?: number;
}

/**
 * One Blender run per call, each in a short-lived child process (an
 * instance is good for one run, and V8 does not reclaim repeated ones).
 */
export function createNodeRunner(options: NodeRunnerOptions): BlenderRunner {
  return {
    async run({ code, blendFile, files, onLine }) {
      const runtimeDir = await ensureRuntime(options.runtimeDir);
      const scratch = await mkdtemp(join(tmpdir(), "blender-wasm-"));
      try {
        const jobPath = join(scratch, "job.json");
        const resultPath = join(scratch, "result.json");
        const staged: Record<string, string> = {};
        const wrapper = [
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
        const all: Files = { ...files, "/job/main.py": new TextEncoder().encode(wrapper), "/job/user.py": new TextEncoder().encode(code) };
        for (const [path, bytes] of Object.entries(all)) staged[path] = Buffer.from(bytes).toString("base64");
        await writeFile(jobPath, JSON.stringify({
          args: ["--background", "--factory-startup", ...(blendFile ? [blendFile] : []), "--python", "/job/main.py"],
          files: staged,
          collect: "/out",
          resultPath,
          completionMarker: COMPLETION_MARKER,
          ...(options.initialMemoryMb ? { initialMemoryMb: options.initialMemoryMb } : {}),
        }));
        try {
          await run(process.execPath, [join(HERE, "run-once.cjs"), jobPath], {
            env: { ...process.env, BLENDER_WASM_RUNTIME_DIR: runtimeDir },
            timeout: options.timeoutMs ?? 600_000,
            maxBuffer: 64 * 1024 * 1024,
          });
        } catch (error) {
          if (!existsSync(resultPath)) throw error;
        }
        const result: { output: string; files: Record<string, string>; error?: string } = JSON.parse(await readFile(resultPath, "utf8"));
        if (result.error) throw Object.assign(new Error(result.error), { output: result.output });
        for (const line of result.output.split("\n")) onLine?.(line);
        const out: Files = {};
        for (const [path, base64] of Object.entries(result.files)) out[path] = new Uint8Array(Buffer.from(base64, "base64"));
        return { output: result.output, files: out };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

/** Runs a bpy script once (`--background --factory-startup`); rejects with the traceback on error. */
export async function runPython(
  code: string,
  options: NodeRunnerOptions & { files?: Files; collect?: string; blendFile?: string },
): Promise<{ output: string; files: Files }> {
  const result = await createNodeRunner(options).run({ code, blendFile: options.blendFile, files: options.files ?? {} });
  const at = result.output.indexOf(ERROR_MARKER);
  if (at >= 0) {
    throw Object.assign(new Error(`Blender Python error:${result.output.slice(at + ERROR_MARKER.length, result.output.indexOf(COMPLETION_MARKER, at))}`), { output: result.output });
  }
  return result;
}
