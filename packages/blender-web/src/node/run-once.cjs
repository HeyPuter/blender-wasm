#!/usr/bin/env node
/**
 * Run exactly one headless Blender invocation and exit.
 *
 *   node run-once.cjs <job.json>
 *
 * The headless wasm build gives one Blender run per module instance: main()
 * runs on a proxied pthread and never returns, so the module cannot be reused,
 * and instantiating it repeatedly in one process exhausts V8 ("CALL_AND_RETRY_LAST
 * Allocation failed" inside WasmInstantiate). One short-lived process per run
 * fixes both: the OS reclaims everything on exit.
 *
 * The job is JSON:
 *
 *   {
 *     "args": ["--background", "--factory-startup", "--python", "/job/main.py"],
 *     "files": { "/job/main.py": "<base64>", "/tmp/in.glb": "<base64>" },
 *     "collect": "/tmp",                     // directory harvested after the run
 *     "resultPath": "/host/path/result.json",
 *     "completionMarker": "<<<BLENDER_RUN_COMPLETE>>>",  // optional
 *     "initialMemoryMb": 256,                 // optional, 256..2048
 *     "systemResources": "/5.3"               // optional, Blender data dir in the module FS
 *   }
 *
 * Completion is detected from `completionMarker` appearing in Blender's output
 * (the factory promise never settles). The result — everything printed, plus
 * every file under `collect` as base64 — is written to `resultPath` rather than
 * stdout, because Blender writes to stdout too.
 *
 * Expects blender.js / blender.wasm / blender.data next to this file, or in
 * BLENDER_WASM_RUNTIME_DIR.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MARKER = "<<<BLENDER_RUN_COMPLETE>>>";
const RUNTIME_DIR = process.env.BLENDER_WASM_RUNTIME_DIR || __dirname;

/** Lines captured so far, shared with the crash path so a crash is diagnosable. */
const captured = [];

function readJob() {
  return JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
}

function writeFailure(error) {
  try {
    const job = readJob();
    fs.writeFileSync(job.resultPath, JSON.stringify({
      output: captured.join("\n"),
      files: {},
      error: String((error && error.stack) || error),
    }));
  } catch {
    process.stderr.write(`run-once failed: ${error}\n`);
  }
}

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    writeFailure(error);
    process.exit(1);
  });
}

/** FS.writeFile/mkdir create one level only; build the whole chain. */
function mkdirp(FS, dir) {
  let current = "";
  for (const part of dir.split("/").filter(Boolean)) {
    current += "/" + part;
    try { FS.mkdir(current); } catch { /* exists */ }
  }
}

function harvest(FS, directory, files) {
  let names = [];
  try {
    names = FS.readdir(directory).filter((name) => name !== "." && name !== "..");
  } catch {
    return;
  }
  for (const name of names) {
    const full = `${directory}/${name}`;
    try {
      const stat = FS.stat(full);
      if (FS.isDir(stat.mode)) harvest(FS, full, files);
      else files[full] = Buffer.from(FS.readFile(full)).toString("base64");
    } catch {
      // Unreadable entries are skipped.
    }
  }
}

async function main() {
  if (!process.argv[2]) {
    process.stderr.write("usage: run-once.cjs <job.json>\n");
    process.exit(2);
  }
  const job = readJob();
  const collect = job.collect || "/tmp";
  const marker = job.completionMarker || DEFAULT_MARKER;
  const initialMemoryMb = Number(job.initialMemoryMb || process.env.BLENDER_WASM_INITIAL_MEMORY_MB || 256);
  if (!Number.isFinite(initialMemoryMb) || initialMemoryMb < 256 || initialMemoryMb > 2048) {
    throw new Error(`initialMemoryMb must be between 256 and 2048, received ${initialMemoryMb}`);
  }

  // blender.wasm / blender.data are located relative to the working directory.
  process.chdir(RUNTIME_DIR);
  const createBlenderModule = require(path.join(RUNTIME_DIR, "blender.js"));
  let moduleRef;

  await new Promise((resolve, reject) => {
    const collectLine = (text) => {
      captured.push(text);
      if (text.includes(marker)) resolve();
    };
    // Deliberately not awaited for completion: the factory promise never settles.
    createBlenderModule({
      INITIAL_MEMORY: initialMemoryMb * 1024 * 1024,
      arguments: job.args,
      print: collectLine,
      printErr: collectLine,
      preRun: [
        (module) => {
          moduleRef = module;
          module.ENV.BLENDER_SYSTEM_RESOURCES = job.systemResources || "/5.3";
          module.ENV.HOME = "/tmp";
          for (const [target, base64] of Object.entries(job.files || {})) {
            mkdirp(module.FS, path.posix.dirname(target));
            module.FS.writeFile(target, Buffer.from(base64, "base64"));
          }
          // collect is an output path nothing stages into; a script writing
          // there would otherwise fail with ENOENT after doing all its work.
          mkdirp(module.FS, collect);
        },
      ],
      onAbort: (what) => reject(new Error(`Blender aborted: ${what}`)),
    }).catch(reject);
  });

  // The parent cannot reach into this module once we exit; harvest now.
  const files = {};
  if (moduleRef) harvest(moduleRef.FS, collect, files);
  fs.writeFileSync(job.resultPath, JSON.stringify({ output: captured.join("\n"), files }));
  // Hard exit: pthread workers keep the event loop alive.
  process.exit(0);
}

main().catch((error) => {
  writeFailure(error);
  process.exit(1);
});
