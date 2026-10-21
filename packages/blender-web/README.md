# @knervous/blender-web

Blender 5.3, compiled to WebAssembly, embedded in your page and kept in sync
with a Babylon.js, Babylon Lite or three.js scene. Blender boots once in a
worker and stays alive, so a sync takes milliseconds. The two sides exchange
typed per-field changes, never whole scenes, and mesh data crosses only where
geometry changed. Python 3.13, numpy and glTF are in the runtime.

```
npm install @knervous/blender-web
```

The package carries the runtime (`runtime/`, brotli) in two builds:

| build | threads | page | notes |
|---|---|---|---|
| `mt` | pthreads | cross-origin isolated | Cycles (CPU) included |
| `st` | one, with JSPI | any page (playgrounds, static hosts) | no Cycles; Blender hands the thread back between requests |

`createBlenderSession({ threads: "auto" })` (the default) takes `mt` where the
page is isolated and `st` everywhere else.

This is the core: the runtime, the project model and an adapter per engine.
Editors, gizmos and tools are for apps to build on top;
[`@knervous/blender-web-editor`](../blender-web-editor) is one (a HUD over
any of the three engines), and `demos/editor` in the repository uses it.

## Entries

| import | what |
|---|---|
| `@knervous/blender-web` | `Project`, typed changes, translators, hooks, `MemoryScene`, the shared description's types |
| `@knervous/blender-web/browser` | `createBlenderSession` (persistent, with boot progress and `session.api`), `createBlenderRunner` (a run per call), `runtimeInstalled` |
| `@knervous/blender-web/ui` | `createBlenderUi`, `showBlenderUi`, `returnFromBlenderUi`: the full Blender UI in an iframe, swapped in and out |
| `@knervous/blender-web/babylon` | `BabylonSide`: entities as `TransformNode`s |
| `@knervous/blender-web/lite` | `LiteSide`: entities as Lite scene nodes, a mesh per material slot |
| `@knervous/blender-web/three` | `ThreeSide`: entities as `Object3D`s |
| `@knervous/blender-web/vite` | `blenderWeb()`: headers, the runtime served in dev and emitted on build |
| `@knervous/blender-web/runtime` | `installRuntime`, `resolveRuntimeDir` (Node, build tooling) |
| `@knervous/blender-web/node` | `createNodeSession`, `createNodeRunner`, `runPython` (Node runtime) |
| `blender-web` (bin) | `blender-web install <dir>`, `blender-web info` |

## Adapters

Each adapter takes the engine from your app and imports only its types, so it
always uses your copy (one copy of each class, whatever the bundler or
playground):

```ts
import * as BABYLON from "@babylonjs/core";
const side = new BabylonSide(BABYLON, scene);        // or just the classes in BabylonApi

import * as THREE from "three";
const side = new ThreeSide(THREE, scene);

import * as LITE from "@babylonjs/lite";
const side = new LiteSide(LITE, engine, scene);
```

The adapter reads the scene as the engine holds it. Move a node, set a mesh's
material, change a material's colour, or dispose a node with the engine's
own API, and the next `project.sync()` carries it. What Blender changes comes
back the same way. `side.track(nodes)` brings engine content into the
project (a loaded glTF, or meshes you made), keeping how it looks.
`side.node(id)`, `idOf`, `entityOf` and `material(name)` map between engine
objects and the project.

## Blender's API, direct

Besides Python (`project.sync({ script })`), a session exposes typed calls
straight into Blender's RNA through embind, with no interpreter in the way.
They run on Blender's own thread between requests (proxied under pthreads,
called directly in the single-threaded build) and take well under a
millisecond each:

```ts
const api = session.api;
await api.get('objects["Cube"].location');              // [0, 0, 0]
await api.set('objects["Cube"].location', [1, 2, 3]);   // true; runs the RNA update
await api.call("mesh.primitive_monkey_add", { location: [0, -3, 1] });  // "FINISHED"
await api.objects();                                     // [{ id, name, kind, parent }]
await api.mesh("Suzanne");                               // evaluated, glTF space, grouped by slot
await api.python("bpy.context.scene.frame_set(12)");     // false if it raised
```

Paths are `bpy.data` paths (`objects["Cube"].modifiers["row"].count`,
`materials["orange"].roughness`). What these calls change is Blender's scene,
so the next `project.sync()` brings it to the engine like any Blender edit.
This is the layer to build a framework-specific editor on; the project model
keeps both sides in step underneath.

## The full Blender UI

`/ui` puts Blender's own interface (the fork's headed WebGPU build) in an
iframe behind a typed bridge, and swaps it with your engine view on the same
.blend:

```ts
import { createBlenderUi, showBlenderUi, returnFromBlenderUi } from "@knervous/blender-web/ui";

const ui = createBlenderUi({ url: "https://blender-ui.example.com/", container });
await showBlenderUi(project, ui);        // hands over project.exportBlend(), shows it
const result = await returnFromBlenderUi(project, ui);  // saves, hides, project.adoptBlend()
```

Boot it at startup: it stays transparent and inert until shown (not
`display: none`, which would stop it drawing), so a swap takes tens of
milliseconds. Coming back is an ordinary sync: only what was edited in the UI
reaches the engine. The UI site is `./build.sh web` (`demo/dist/`). Host it
with the headers in `demo/public/_headers`; `npx wrangler deploy` in `demo/`
publishes it as Cloudflare Workers static assets (`demo/wrangler.jsonc`). On
an origin's first visit the site seeds default preferences with the splash
off, so an embedded UI opens straight to the scene. `Document-Isolation-Policy`
there lets it run its threads inside any page, isolated or not. Messages
are checked by origin and source, and `parent=` tells the UI which origin
may drive it.

## With Vite

```js
// vite.config.js
import { blenderWeb } from "@knervous/blender-web/vite";
export default { plugins: [blenderWeb()] };
```

```ts
import * as THREE from "three";
import { Project } from "@knervous/blender-web";
import { createBlenderSession } from "@knervous/blender-web/browser";
import { ThreeSide } from "@knervous/blender-web/three";

const scene = new THREE.Scene();
const side = new ThreeSide(THREE, scene);          // adds its project root to the scene
const session = createBlenderSession({
  onProgress: ({ fraction, detail }) => { bar.style.width = `${fraction * 100}%`; label.textContent = detail; },
});
const project = new Project({ session, scene: side });

await project.newScene();                          // Blender's startup scene arrives as creates
const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: "red" }));
scene.add(box);
side.track([box]);
await project.sync();                              // only the new box goes out
await project.sync({ script: "import bpy\nbpy.ops.mesh.primitive_monkey_add()" });
const blend = await project.exportBlend();
```

The plugin:

- sends `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` from dev and preview (for `mt`);
- keeps this package out of `optimizeDeps`;
- serves `blender-runtime/` in dev (brotli when the browser accepts it);
- writes the runtime into `outDir/blender-runtime/` on build.

## Without Vite

Copy the runtime to where your pages are served, then point the session at
it:

```
npx blender-web install public/blender-runtime
```

```ts
createBlenderSession({ runtimeUrl: "/blender-runtime/" }); // the default is "blender-runtime/" under the page's base
```

The directory holds a manifest, the two workers and a directory per build
(`blender.js`, `blender.wasm`, `blender.data` and their `.br` copies). Every
file is checked against the runtime's sha256 manifest on install.

## Serving it

- **Isolation.** `mt` needs `SharedArrayBuffer`, so a cross-origin isolated
  page. On any other page `threads: "auto"` runs `st`; `threads: true` there
  throws `NotIsolatedError`.
- **Compression.** Serve `blender.wasm` and `blender.data` with
  `Content-Encoding: br` from the `.br` copies (about 32 MB per build instead
  of 170 MB). `blender.wasm` must be `application/wasm` for streaming
  compilation. Progress uses the manifest's raw sizes, so it stays right
  when compressed.
- **Caching.** The files change only with the package version, so cache them
  long on a versioned path, or revalidate.
- **Loading model.** This is the static-directory model of pyodide's
  `indexURL` and onnxruntime's `wasmPaths`, not bundler imports. The workers
  and the emscripten glue load unmodified: Blender's pthreads re-load the
  glue, and a bundled copy breaks them. The page compiles `blender.wasm` while
  `blender.data` downloads, then hands both to the worker (`instantiateWasm`).
- **From a CDN.** The package's own `runtime/` is a servable runtime, so a
  CDN serving the package works as `runtimeUrl`:

  ```ts
  createBlenderSession({ runtimeUrl: "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.3/runtime/" });
  ```

  A CDN sends the `.br` files as plain bytes (browsers decode brotli only as
  a Content-Encoding, and `DecompressionStream` has none), so the page
  streams them through `brotli-decode.wasm` (174 KB, brotli's own decoder)
  while `blender.wasm` compiles. The origin must send CORS (and
  `Cross-Origin-Resource-Policy: cross-origin` for an isolated page).
  Workers must be same-origin, so they start from a blob that imports the
  real script, the workaround emscripten's maintainers gave in
  emscripten#21937. `demos/playground/` has scratch files for the Babylon.js
  and Babylon Lite playgrounds.

## Node

The Node runtime is a separate build (`./build.sh node`), not published yet:

```ts
import { MemoryScene, Project } from "@knervous/blender-web";
import { createNodeSession } from "@knervous/blender-web/node";

const session = await createNodeSession({ runtimeDir: "dist/blender-wasm-node" });
const project = new Project({ session, scene: new MemoryScene() });
await project.newScene();
await project.sync({ script: "import bpy\nbpy.ops.mesh.primitive_monkey_add()" });
process.exit(0); // Blender's threads keep the process alive
```

## Design

`DESIGN.md` covers the sync model (identity, the shared description, typed
changes, conflicts), translators, adapters and hooks, the persistent session,
boot, and the measurements against the previous whole-scene approach.

## License

GPL-3.0-or-later: Blender as a whole is GPL-3.0-or-later (its sources are
GPL-2.0-or-later; Apache-2.0 dependencies make the program GPL-3), and so is
this package. `THIRD-PARTY-LICENSES.md` lists what the runtime contains and
carries the upstream notices. Files produced *by* Blender, such as `.glb` and
`.blend`, are not covered.
