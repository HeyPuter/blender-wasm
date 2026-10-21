#!/usr/bin/env node
/**
 * Links the full Blender UI (the headed WebGPU build) into public/blender-ui/,
 * for "Open in Blender UI". From ../../demo/dist (../../build.sh web); runs
 * that build when it is missing, or with --rebuild.
 *
 * The headless runtime the editor drives needs no step here: it is the
 * @knervous/blender-web package, served by the Vite plugin.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const demo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(demo, "../..");
const rebuild = process.argv.includes("--rebuild");

const dir = process.env.BLENDER_WASM_UI_DIR ?? join(repo, "demo", "dist");
if (rebuild || !existsSync(join(dir, "blender.wasm.zst"))) {
  console.log(`[blender] building: ${repo}/build.sh web`);
  const result = spawnSync(join(repo, "build.sh"), ["web"], { stdio: "inherit", env: rebuild ? { ...process.env, FORCE: "1" } : process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// The UI loads its own compressed runtime; link the site rather than copy ~120 MB.
const out = join(demo, "public", "blender-ui");
rmSync(out, { recursive: true, force: true });
symlinkSync(relative(dirname(out), dir), out, "dir");
console.log(`[blender] Blender UI -> ${out} (links ${dir})`);
