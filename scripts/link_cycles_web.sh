#!/usr/bin/env bash
# Relink the Cycles standalone wasm module with web-ready flags. CMake links
# bin/cycles.js with a tiny 16MB heap and no runtime exports/preload — useless
# in a browser. We reuse CMake's exact object/library link line (so we never
# drift from the build) and append the web settings, emitting web/cycles.{js,wasm,data}.
set -euo pipefail
ROOT="${ROOT:-/home/admin/blender-wasm}"
export PATH="$ROOT/emsdk/upstream/emscripten:$PATH"
BUILD="$ROOT/build-cycles"
WEB="$ROOT/web"

# Grab CMake's link command for the `cycles` target, drop the leading `: && `.
raw=$(ninja -C "$BUILD" -t commands cycles | grep -- "-o bin/cycles.js" | tail -1)
cmd=${raw#*&& }
cmd=${cmd% && :}     # ninja appends a trailing `&& :`; strip it or our flags
                     # would be passed to `:` (a no-op) instead of em++.
# Retarget output into web/ (and run from the build dir so relative .o/.a resolve).
cmd=${cmd/-o bin\/cycles.js/-o $WEB/cycles.js}

# Web runtime flags. PROXY_TO_PTHREAD keeps the render off the browser UI thread
# (Cycles blocks + spawns worker pthreads); generous growable memory; full FS +
# callMain exported so JS can run the CLI and read the output PNG back; the scene
# dir is baked in via --preload-file (honors the WASMFS+preload asset decision).
# Cycles render threads recurse deeply (BVH traversal / path integration); the
# emscripten default thread stack (64KB) overflows and hard-crashes the tab.
# Give the proxied main and all pthreads generous stacks. Keep symbols (-g2) and
# assertions so any remaining trap is readable.
WEB_FLAGS="-pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=0 -g2 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=2147483648 \
  -sSTACK_SIZE=8388608 -sDEFAULT_PTHREAD_STACK_SIZE=8388608 \
  -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sWASMFS -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap \
  -sENVIRONMENT=web,worker -sASSERTIONS=2 \
  --preload-file $WEB/scenes@/scenes"
# -sWASMFS: the render runs on the proxied-main worker pthread; WASMFS keeps the
# file store in shared wasm memory so /out.png written there is visible to
# FS.readFile on the browser main thread (plain MEMFS is per-thread).
# NOTE: no -sOFFSCREENCANVAS_SUPPORT here — headless CPU render has no GL canvas,
# and that flag makes pthread_create fail trying to transfer a missing #canvas.
# OffscreenCanvas comes back for the GL/GUI phase.

echo ">> relinking cycles → $WEB/cycles.js (web-ready)"
( cd "$BUILD" && eval "$cmd $WEB_FLAGS" )
ls -la "$WEB"/cycles.js "$WEB"/cycles.wasm "$WEB"/cycles.data 2>&1
echo ">> done"
