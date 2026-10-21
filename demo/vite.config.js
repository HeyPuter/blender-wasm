import { defineConfig } from "vite";

import basicSsl from '@vitejs/plugin-basic-ssl'

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
  plugins: [basicSsl()],
  server: {
    headers: isolationHeaders,
    allowedHosts: true,
    https: !!process.env.SSL,
  },
  preview: { headers: isolationHeaders },
  // The large precompiled runtime is installed into dist separately. Preserve
  // it while rebuilding this small launcher shell.
  build: { target: "esnext", emptyOutDir: false },
});
