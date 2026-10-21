# @knervous/blender-web-editor

An editor HUD on [`@knervous/blender-web`](../blender-web). It docks over
your Babylon.js, Babylon Lite or three.js canvas and makes your scene and
Blender (WebAssembly, in the same tab) one project:

- edit in the engine (gizmos, add, delete, materials) and sync to Blender
- run Python or direct RNA calls in Blender, and sync the result back
- open a `.blend` or anything Blender imports, and download `.blend`/`.glb`
- swap to the full Blender UI on the same `.blend` and back, in tens of
  milliseconds

```
npm install @knervous/blender-web-editor
```

Your app keeps its engine, scene, camera and render loop. The editor only
gets the scene, through a viewport for your engine:

```ts
import * as BABYLON from "@babylonjs/core";
import "@babylonjs/loaders";
import { mountEditor } from "@knervous/blender-web-editor";
import { babylonViewport } from "@knervous/blender-web-editor/babylon";

const editor = mountEditor({
  container: document.getElementById("stage")!,   // the element over your canvas
  viewport: babylonViewport(BABYLON, scene),
  blenderUi: "https://blender-ui.example.com/",  // optional: the full Blender UI
});
await editor.ready;
```

| engine | viewport |
|---|---|
| Babylon.js | `babylonViewport(BABYLON, scene, { helpers? })` |
| Babylon Lite | `liteViewport(LITE, engine, scene, canvas)` (no gizmos) |
| three.js | `threeViewport(THREE, scene, camera, canvas, { TransformControls, GLTFLoader, GLTFExporter, orbit })` |

Each viewport takes your copy of the engine and imports only its types. For
another engine, implement `Viewport` around the core's `EngineSide`.

`mountEditor` returns `{ project, session, ui, ready, openFile,
showBlenderUi, returnFromBlenderUi, refresh, dispose }`. `project` is the
core's `Project`, `session.api` Blender's direct API, and `ui` the Blender UI
bridge, for anything the HUD does not do.

Options: `runtimeUrl` (where the runtime is served; default
`blender-runtime/`, or the core package's `runtime/` on a CDN), `threads`
(`"auto"`, `true`, `false`), `blenderUi`, `title`, `python` (the starting
script).

The HUD's styles are scoped under `.bwe` and injected once.

## License

GPL-3.0-or-later, like Blender and `@knervous/blender-web`.
