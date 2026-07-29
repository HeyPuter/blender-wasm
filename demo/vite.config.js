import { defineConfig } from "vite";

/* Blender-wasm needs SharedArrayBuffer (pthreads): cross-origin isolation on
 * both the dev server and the preview server. */
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export default defineConfig({
  /* Emit relative asset URLs (./assets/...) so the built site works when served
   * from any subpath, not just the domain root. The runtime fetches
   * (blender.wasm.zst, assets.tar.zst, manifest.json, blender.js) are already
   * document-relative in main.js, so they follow the page's location too. */
  base: "./",
  server: {
    headers: isolationHeaders,
    allowedHosts: true
  },
  preview: { headers: isolationHeaders },
  build: { target: "esnext" },
});
