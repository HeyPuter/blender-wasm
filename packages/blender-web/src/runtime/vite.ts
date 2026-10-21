/**
 * Vite plugin: serves the Blender runtime in dev and emits it on build.
 *
 *   import { blenderWeb } from "@knervous/blender-web/vite";
 *   export default { plugins: [blenderWeb()] };
 *
 * - dev and preview get the cross-origin isolation headers (pthreads need
 *   SharedArrayBuffer);
 * - this package is kept out of dependency pre-bundling (the workers and
 *   glue must load unmodified);
 * - `<base>blender-runtime/` is served from a cache under node_modules/.cache
 *   in dev (brotli when the browser accepts it) and written into the build's
 *   outDir, .br copies included, for a server to send with Content-Encoding.
 *
 * Pages then use `createBlenderSession()` with the default runtimeUrl, or
 * pass `runtimeUrl: import.meta.env.BASE_URL + "blender-runtime/"`.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { CROSS_ORIGIN_ISOLATION, RUNTIME_CONTENT_TYPES, installRuntime } from "./index.ts";

export interface BlenderWebPluginOptions {
  /** Path under the site's base where the runtime is served (default "blender-runtime/"). */
  path?: string;
  /** A runtime directory other than the packaged one. */
  runtimeDir?: string;
  /** Add COOP/COEP to dev and preview (default true). */
  isolate?: boolean;
  /** Write .br copies into the build (default true). */
  compressed?: boolean;
}

export function blenderWeb(options: BlenderWebPluginOptions = {}): Plugin {
  const path = (options.path ?? "blender-runtime/").replace(/^\/+/, "").replace(/\/?$/, "/");
  const isolate = options.isolate ?? true;
  let config: ResolvedConfig;
  return {
    name: "blender-web",
    config: () => ({
      server: isolate ? { headers: { ...CROSS_ORIGIN_ISOLATION } } : {},
      preview: isolate ? { headers: { ...CROSS_ORIGIN_ISOLATION } } : {},
      optimizeDeps: { exclude: ["@knervous/blender-web"] },
    }),
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      const cache = resolve(config.cacheDir, "blender-web-runtime");
      const { manifest, skipped } = installRuntime({
        dest: cache, runtimeDir: options.runtimeDir, compressed: true,
        log: (line) => config.logger.info(`[blender-web] ${line}`),
      });
      config.logger.info(`[blender-web] runtime ${manifest.forkRevision}${skipped ? " (cached)" : ""} at ${config.base}${path}`);
      const prefix = `${config.base}${path}`;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith(prefix)) return next();
        const name = normalize(decodeURIComponent(url.slice(prefix.length)));
        const file = join(cache, name);
        if (name.startsWith("..") || name.startsWith(".blender") || !existsSync(file) || !statSync(file).isFile()) return next();
        const brotli = join(cache, `${name}.br`);
        const accepts = /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""));
        const send = accepts && existsSync(brotli) ? brotli : file;
        res.setHeader("Content-Type", RUNTIME_CONTENT_TYPES[extname(name)] ?? "application/octet-stream");
        res.setHeader("Content-Length", statSync(send).size);
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        if (isolate) for (const [key, value] of Object.entries(CROSS_ORIGIN_ISOLATION)) res.setHeader(key, value);
        if (send === brotli) {
          res.setHeader("Content-Encoding", "br");
          res.setHeader("Vary", "Accept-Encoding");
        }
        createReadStream(send).pipe(res);
      });
    },
    writeBundle() {
      if (config.command !== "build") return;
      const { dest } = installRuntime({
        dest: resolve(config.root, config.build.outDir, path), runtimeDir: options.runtimeDir,
        compressed: options.compressed ?? true,
      });
      config.logger.info(`[blender-web] runtime written to ${dest}`);
    },
  };
}

export default blenderWeb;
