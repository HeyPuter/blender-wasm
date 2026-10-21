# Playground scratch files

Each scene loads Babylon's aerobatic plane from its CDN, adopts it into a
project with Blender (WebAssembly, in the page), and lets Blender's Array and
Mirror modifiers turn it into a V formation. The engine keeps its textured
material; only geometry comes back. The HUD's "Blender UI" button swaps to
Blender's own interface (hosted at https://blender-web-ui.pcj174.workers.dev/)
and back.

| file | where | link |
|---|---|---|
| `babylon-editor.js` | Babylon.js Playground | https://playground.babylonjs.com/#39AEDW |
| `lite-editor.ts` | Babylon Lite Playground | https://liteplayground.babylonjs.com/snippet/85ARVP/v/0 |
| `three-stackblitz/` | StackBlitz (npm + Vite) | https://stackblitz.com/github/knervous/blender-wasm/tree/master/demos/playground/three-stackblitz |
| `three-codepen.html` | CodePen (paste into the HTML panel), or any static server | — |
| `babylon.js`, `lite.ts` | the playgrounds, core adapter only (no HUD) | — |

The saved links run @knervous/blender-web-editor 0.0.2 on core 0.0.5. A saved
snippet never changes: after editing a file here, paste it into the playground
and save again (a new version or link).
