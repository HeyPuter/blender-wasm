// Tiny static file server that sets the cross-origin isolation headers
// (COOP/COEP) WASM pthreads + SharedArrayBuffer require. Used by both the
// dev workflow and the Playwright verifier.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.argv[3] || 8080);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let p = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let s = await stat(p).catch(() => null);
    if (s && s.isDirectory()) { p = join(p, "index.html"); s = await stat(p).catch(() => null); }
    if (!s) { res.writeHead(404).end("not found: " + url.pathname); return; }
    const body = await readFile(p);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(p)] || "application/octet-stream",
      // pthreads / SharedArrayBuffer require cross-origin isolation:
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

server.listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
