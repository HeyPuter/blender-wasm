#!/usr/bin/env bash
# Relink the full Blender wasm module for the BROWSER (WebGPU backend).
#
# CMake links bin/blender.js as a node CLI app (NODERAWFS, ENVIRONMENT=node).
# In a browser there is no real filesystem and the WebGPU device must come from
# JS. We reuse CMake's exact object/library link line (so we never drift from the
# build) and swap the node-isms for web settings + preload Blender's runtime
# assets (scripts, datafiles, CPython stdlib), emitting web/blender.{js,wasm,data}.
#
# Goal of this harness: full Blender running in chromium with a REAL WebGPU
# device handed in from JS (Module.preinitializedWebGPUDevice) so the render
# pipeline enters the WebGPU backend with device_ != null. EEVEE pixels need the
# rest of the backend; this unblocks all of that by making it browser-verifiable.
set -euo pipefail
ROOT="${ROOT:-/home/admin/blender-wasm}"
export PATH="$ROOT/emsdk/upstream/emscripten:$PATH"
BUILD="$ROOT/build-blender"
WEB="$ROOT/web"
SYSROOT="$ROOT/wasm-sysroot"
STAGE="$ROOT/web/blender_assets"

# --- stage runtime assets (trim CPython stdlib: drop tests/caches) ----------
echo ">> staging assets -> $STAGE"
rm -rf "$STAGE"; mkdir -p "$STAGE/5.3"
cp -r "$ROOT/blender/scripts"          "$STAGE/5.3/scripts"
cp -r "$ROOT/blender/release/datafiles" "$STAGE/5.3/datafiles"
cp -r "$SYSROOT/lib/python3.13" "$STAGE/python3.13"
# Trim weight not needed at runtime (tests, caches, dev-only modules).
( cd "$STAGE/python3.13" && rm -rf test tests idlelib lib2to3 turtledemo tkinter \
    && find . -name '__pycache__' -type d -prune -exec rm -rf {} + )
echo ">>   scripts=$(du -shL "$STAGE/5.3/scripts"|cut -f1) datafiles=$(du -shL "$STAGE/5.3/datafiles"|cut -f1) py=$(du -sh "$STAGE/python3.13"|cut -f1)"

# --- grab CMake's exact link command for the `blender` target ---------------
raw=$(ninja -C "$BUILD" -t commands blender | grep -- "-o bin/blender.js" | tail -1)
# The rule is:  : && <em++ link …> && cd <dir> && cmake -E echo Run:…
# Take only the em++ link segment: drop the leading ': && ' and everything from
# the trailing ' && cd …' POST_BUILD chain onward.
cmd=${raw#*&& }
cmd=${cmd%% && cd *}

# Retarget output to web/.
cmd=${cmd/-o bin\/blender.js/-o $WEB/blender.js}
# Drop node-only filesystem + environment settings (we replace them below).
cmd=${cmd//-sNODERAWFS=1/}

# Web runtime flags. PROXY_TO_PTHREAD: Blender's main + worker pthreads run off
# the browser UI thread. WASMFS keeps the file store in shared memory so the
# render output written on the proxied-main worker is readable from the UI
# thread. Preload Blender's scripts/datafiles at /5.3 and CPython at its compiled
# prefix path. callMain/FS exported so JS can run the CLI and read results back.
# NOTE: deliberately NOT using PROXY_TO_PTHREAD. The WebGPU device is a live JS
# GPUDevice handed in via Module.preinitializedWebGPUDevice; it cannot cross to a
# worker thread, so the render (which creates the GPU context) must run on the
# browser main thread where the device lives. Blender's worker pthreads are
# served from a pre-spawned pool so pthread_create doesn't need the (blocked)
# main thread. The GPU context is created early in the render, before heavy
# multithreading, so this reaches device acquisition.
WEB_FLAGS="-pthread -sEXIT_RUNTIME=0 -g2 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1073741824 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=32 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sWASMFS -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8,HEAPU16,HEAPF32 \
  -sENVIRONMENT=web,worker -sASSERTIONS=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  --preload-file $STAGE/5.3@/5.3 \
  --preload-file $STAGE/python3.13@$SYSROOT/lib/python3.13"

echo ">> relinking blender → $WEB/blender.js (web + WebGPU)"
( cd "$BUILD" && eval "$cmd $WEB_FLAGS" )
ls -la "$WEB"/blender.js "$WEB"/blender.wasm "$WEB"/blender.data 2>&1
echo ">> done"
