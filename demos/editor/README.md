# Blender editor (Babylon.js, Babylon Lite or three.js)

A small editor with Blender running in the same tab, compiled to
WebAssembly. The page sets up its engine and mounts
[`@knervous/blender-web-editor`](../../packages/blender-web-editor) over it,
on [`@knervous/blender-web`](../../packages/blender-web).
`?engine=lite` uses Babylon Lite (WebGPU, no gizmos), `?engine=three` three.js; Babylon.js is the default. `?threads=0` forces the single-threaded build, `?threads=1` the pthread one. Open a `.blend` (or
anything Blender imports) and edit it in the engine. Moves, deletions, new
objects, material assignment and material colour, metallic and roughness all
sync back onto the Blender objects. You can also run `bpy` against the scene,
adopt engine content into the project, or edit in Blender's own UI.

```bash
../../build.sh browser     # once: the pthread runtime (../../dist/blender-wasm-browser)
../../build.sh browser-st  # and/or the single-threaded one
npm install
npm run dev              # http://localhost:5321  (?engine=lite|three, ?threads=0|1)
```

The three engines, the packages and Vite are dev dependencies. The packages
come from this repository (`../../packages/`, built and copied in by
`predev`; `.npmrc` installs them as copies, as a registry would, so there is
one copy of each engine), and the core's build takes the runtimes from
`../../dist/`. A first
`./build.sh browser` compiles Blender from source, which takes hours (see the
top-level README).
`npm run blender:ui` links the full Blender UI (`../../build.sh web`) for
the "Blender UI" swap (`?ui=<url>` uses a hosted one instead).

## How Blender runs

`blenderWeb()` in `vite.config.js` serves the runtime at `blender-runtime/`
and sends the cross-origin isolation headers Blender's threads need. A build
writes the runtime into `dist/blender-runtime/` with `.br` copies, and the
host must send the same headers. Blender boots once in one worker, with the
project protocol running as a server. It stays alive for the page, keeping
the scene in memory, so a sync takes milliseconds plus its work. Nothing runs
on a server.

The editor UI (`src/main.ts`) is the same for every engine. Each engine has a
viewport (`src/viewport-babylon.ts`, `src/viewport-lite.ts`, `src/viewport-three.ts`): camera, gizmos,
picking and engine-only file loading around the package's adapter
(`BabylonSide`, `LiteSide`, `ThreeSide`), on the engine's own API: the
package is the core adapter, and these editing tools are the app's. Only the
chosen engine is loaded.

## How the two sides stay in step

The page and Blender share one project (design in
[`DESIGN.md`](../../packages/blender-web/DESIGN.md)). Every object has a stable id. A sync
sends only what the engine changed since the last agreed state and applies only
what Blender changed. Mesh data crosses only for geometry whose fingerprint
moved; there is no whole-scene export or reload.
The adapter builds nodes from the changes and reads them back. In Babylon,
project entities live under a root identical to the one its glTF loader
builds, so a `.blend` looks the way its glTF export would; three.js needs no
conversion.

| action | what crosses |
|---|---|
| New Blender scene / Open | The file becomes the project, and its objects arrive as creates. A `.blend` opens as-is; `.glb/.gltf/.obj/.fbx/.stl/.ply` are imported into an empty scene. |
| Move, rotate, scale, delete, Add box/sphere | Listed under **Sync** as pending changes, typed and per object. |
| Material panel (selected mesh) | Pick the material in slot 0, make a **New** one, or edit its colour, metallic and roughness. The material is shared by everything using it, and both the assignment and the properties are pending changes. |
| **Sync with Blender** | Just those changes go out (create with mesh data, delete, update one field). What comes back is only what Blender changed beyond them. *Auto-sync* sends them shortly after each edit. |
| **Run Python** | A sync, plus a `bpy` script; only what the script changed comes back. |
| Shift+open a glTF/OBJ/STL (or `.babylon`/USD in Babylon.js) | Loaded into the engine outside the project. **Adopt outside content** brings it in, keeping its placement; the next sync creates it in Blender. |
| **Open in Blender UI** → Save back | The edited `.blend` is adopted: pending engine edits are replayed onto it, and where both sides changed a field the conflict policy decides (Blender by default). The result is logged. |

The status line and log show each sync's traffic, for example
`sent ~ Cube.transform, + box_ee7f · received ~ box_ee7f mesh (36 verts)`.

## Limits of this build

- No OpenSubdiv, so Subdivision Surface does nothing. Array, Bevel, Mirror and
  the other non-subdivision modifiers work.
- Booting Blender takes a few seconds once per page; syncs after that take
  milliseconds (see `packages/blender-web/DESIGN.md`).
- Mesh edits made in the engine travel only when an object is created; see the
  limits in `packages/blender-web/DESIGN.md`.
- `bench.html?mode=session|sdk|legacy` (Babylon.js) measures the sync against the previous
  whole-scene path; results are in `packages/blender-web/DESIGN.md`.
- The console shows a `_multiprocessing` traceback on every run. That's an
  add-on import Blender reports and moves past.
