# Blender in WebAssembly

<img width="1907" height="1076" alt="Blender running in a browser tab" src="https://github.com/user-attachments/assets/04296d56-da28-42b7-bf9d-f703ccf15684" />

Build orchestration for compiling Blender to WebAssembly with emscripten. The
Blender source is a fork (`BLENDER_URL` / `BLENDER_REF` in the Makefile, default
[HeyPuter/blender](https://github.com/HeyPuter/blender)) that carries the wasm
patches and the WebGPU backend. This repo holds the toolchain pin, the
dependency builds, the link scripts, the Node API and the browser demo.

Three things can be built from one checkout:

| flavour | command | what you get |
|---|---|---|
| **node** | `./build.sh node` | Headless Blender for Node. No window, no GPU; `bpy`, glTF import/export (numpy included), Cycles CPU. A runtime package plus a JS API. |
| **browser** | `./build.sh browser` | The same headless module linked for web workers. |
| **web** | `./build.sh web` | Full Blender UI on WebGPU, as a static site (`demo/`). |

## Quick start

```bash
./build.sh doctor   # checks host tools; fix anything it flags
./build.sh node     # or: browser, web
```

A first build compiles the whole dependency stack (CPython 3.13, OpenImageIO,
OpenEXR, OCIO, TBB, Tint/SPIRV/shaderc, numpy, ...) and Blender itself. That
takes hours and about 40 GB of disk. Every step writes a stamp, so re-running
the same command only redoes what changed. `FORCE=1` redoes everything.

**Host prerequisites:** git, git-lfs, cmake, ninja, make, pkg-config, curl,
unzip, patch, zstd, Python 3.10+, Node 22.15+, a host C++ compiler, and
optionally brotli. On macOS, also the GNU tools from Homebrew
(`brew install make gnu-sed findutils coreutils`), which `scripts/env.sh` puts
ahead of the BSD ones. emscripten is installed into `./emsdk` at a pinned
version (6.0.1), and any `EMSDK` already in your shell is ignored.

## Outputs

```
dist/blender-wasm-browser/    pthread runtime: blender.js, blender.{wasm,data}.br, manifest.json, LICENSE
dist/blender-wasm-browser-st/ single-threaded (JSPI) runtime, same files
dist/blender-wasm-node/       the Node runtime: blender.js, blender.{wasm,data}.zst, manifest.json, LICENSE
dist/blender-web-<rev>.tar.gz the demo site (serve dist/ cross-origin isolated)
```

`manifest.json` records the size and sha256 of every file, compressed and raw,
plus the fork revision, Blender commit, emsdk version and wasm-opt level the
runtime was built from.

## npm package

[`@knervous/blender-web`](packages/blender-web) is the runtime and the core:
both browser builds (`./build.sh browser`, pthreads, for cross-origin
isolated pages; `./build.sh browser-st`, single-threaded with JSPI, for any
page), the project model, adapters for Babylon.js (`/babylon`), Babylon Lite
(`/lite`) and three.js (`/three`), a Vite plugin (`/vite`), a
`blender-web install <dir>` CLI and a Node session (`/node`). `npm run build`
there takes the runtimes from `dist/`.

```js
// vite.config.js
import { blenderWeb } from "@knervous/blender-web/vite";
export default { plugins: [blenderWeb()] }; // headers, runtime served and emitted

// app
import * as THREE from "three";
import { Project } from "@knervous/blender-web";
import { createBlenderSession } from "@knervous/blender-web/browser";
import { ThreeSide } from "@knervous/blender-web/three"; // or BabylonSide / LiteSide

const project = new Project({ session: createBlenderSession(), scene: new ThreeSide(THREE, scene) });
await project.newScene();
```

The package README covers setup, serving and the Node session. `DESIGN.md`
covers the sync model, the session and the measurements.

## Embedding the web build

The demo can run inside a same-origin iframe as an editing surface: the host
supplies a `.blend`, and later asks for the edited file back:

```html
<iframe src="/blender/?embed=1&session=/api/scene.blend&id=chair-01"></iframe>
```

The protocol is `postMessage` with `blender-embed-*` messages, documented in
[`demo/src/embed.js`](demo/src/embed.js). The page must be served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, because pthreads need
`SharedArrayBuffer`.

## Demos

[`demos/editor`](demos/editor) is an example editor on Babylon.js, Babylon
Lite (`?engine=lite`) or three.js (`?engine=three`) wired to headless Blender in both directions. Edits in the
engine push back onto the `.blend`, and `bpy` scripts and Blender imports show
up in the engine. Blender runs in the tab: it uses the pthread browser runtime
and assumes cross-origin isolation.

## Optimising and compressing

The relinks run at `-O1` so iteration stays fast. `./build.sh node|browser`
then runs one Binaryen pass over the finished module:

```bash
WASM_OPT_LEVEL=-O3 ./build.sh node     # -O2 by default; -Os / -Oz for size
OPTIMIZE=0 ./build.sh node             # skip it
./build.sh optimize node/              # on an existing link
./build.sh compress node/blender.wasm  # .zst (+ .br)
```

The pass only rewrites function bodies. Imports, exports, the table and the
`dylink.0` section are untouched, so `blender.js` and numpy's side modules
keep working. Measured on the headless module: 108.9 MB → 92.7 MB at `-O2`, in
about 60 s with 3.8 GB peak RSS. `WASM_OPT_STRIP=1` also drops the name section
(smaller, but stack traces lose function names).

`.zst` (level 21) is what the bundled loaders read. `.br` is for serving with
`Content-Encoding: br`, which browsers decode natively.

## Steps

`./build.sh help` lists every step: `toolchain`, `source`, `deps`, `numpy`,
`configure headless|gui`, `compile`, `link node|browser|web`, `optimize`,
`compress` and `package`. The Makefile targets are the same steps without stamps.

The headless and GUI configures share `build-blender/` by default, so switching
flavours recompiles Blender. If disk allows, give each its own tree:

```bash
BLENDER_BUILD=$PWD/build-headless ./build.sh node
BLENDER_BUILD=$PWD/build-gui      ./build.sh web
```

## Notes for maintainers

- **Undefined symbols.** The headless module is linked `-sMAIN_MODULE=1` so
  CPython can `dlopen` numpy. Its loader refuses to start while any symbol is
  undefined, so `scripts/undef_symbols.txt` (tracked) is compiled into no-op
  stubs. These cover CPython's bz2/sqlite3 modules, which have no library here,
  the two `wgpu_*` entry points, WasmFS backends, and `execinfo`. None of them
  are reachable in `--background`. A MAIN_MODULE link does not warn about
  undefined symbols, so after linking the script lists any that are still
  unresolved (the glue marks each with `.stub = true`). `AUTO_STUB=1` appends
  them and relinks. A symbol that a numpy side module imports needs its real
  prototype in `scripts/gen_undef_stubs.py`.
- **`-fPIC` everywhere.** `MAIN_MODULE` requires position-independent inputs,
  so the dependency stack is built `-fPIC` (`scripts/dep_common.sh`). One
  sysroot serves every flavour.
- Each link script explains its emscripten flags at the top. Read it before
  changing them: several look optional and are not.

## License

Blender is GPL-2.0-or-later, and so is everything built here (see `LICENSE`).
Files produced *by* Blender, such as `.glb` and `.blend`, are not covered by
the GPL.
