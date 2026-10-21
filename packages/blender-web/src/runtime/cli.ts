#!/usr/bin/env node
/**
 *   blender-web install <dir> [--no-br] [--runtime <dir>]
 *       copy the browser runtime into <dir> (e.g. public/blender-runtime), for
 *       bundlers other than Vite (which has `@knervous/blender-web/vite`)
 *   blender-web info [--runtime <dir>]
 *       where the runtime package is and what it was built from
 */
import { installRuntime, readRuntimeManifest, resolveRuntimeDir } from "./index.ts";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest.splice(at, 2)[1] : undefined;
};
const runtimeDir = flag("--runtime");
const noBrotli = rest.includes("--no-br");
const positional = rest.filter((arg) => !arg.startsWith("--"));

try {
  if (command === "install" && positional[0]) {
    const { dest, manifest, skipped } = installRuntime({
      dest: positional[0], runtimeDir, compressed: !noBrotli, log: console.log,
    });
    console.log(`${skipped ? "up to date" : "installed"}: runtime ${manifest.forkRevision} in ${dest}`);
  } else if (command === "info") {
    const dir = resolveRuntimeDir({ runtimeDir });
    const manifest = readRuntimeManifest(dir);
    console.log(JSON.stringify({ dir, ...manifest }, null, 2));
  } else {
    console.log("usage: blender-web install <dir> [--no-br] [--runtime <dir>] | blender-web info");
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
