#!/usr/bin/env bash
# Relink full Blender wasm for NODE.js (WebGPU backend via @kmamal/gpu → Dawn →
# lavapipe). Unlike the browser harness (SwiftShader, baseline limits), Dawn-native
# on lavapipe exposes the real device limits (8 storage textures/stage, 1024
# workgroup) that EEVEE-Next's compute passes need. We reuse CMake's exact link
# line, swap to ENVIRONMENT=node, and emit node-webgpu/blender_node.{js,wasm,data}.
set -euo pipefail
ROOT="${ROOT:-/home/admin/blender-wasm}"
export PATH="$ROOT/emsdk/upstream/emscripten:$PATH"
BUILD="$ROOT/build-blender"
OUT="$ROOT/node-webgpu"
SYSROOT="$ROOT/wasm-sysroot"
STAGE="$ROOT/web/blender_assets"   # reuse assets staged by link_blender_web.sh

if [ ! -d "$STAGE/5.3" ]; then
  echo ">> staging assets -> $STAGE"
  rm -rf "$STAGE"; mkdir -p "$STAGE/5.3"
  cp -r "$ROOT/blender/scripts"          "$STAGE/5.3/scripts"
  cp -r "$ROOT/blender/release/datafiles" "$STAGE/5.3/datafiles"
  cp -r "$SYSROOT/lib/python3.13" "$STAGE/python3.13"
  ( cd "$STAGE/python3.13" && rm -rf test tests idlelib lib2to3 turtledemo tkinter \
      && find . -name '__pycache__' -type d -prune -exec rm -rf {} + )
fi

mkdir -p "$OUT"
raw=$(ninja -C "$BUILD" -t commands blender | grep -- "-o bin/blender.js" | tail -1)
cmd=${raw#*&& }
cmd=${cmd%% && cd *}
cmd=${cmd/-o bin\/blender.js/-o $OUT/blender_node.js}
cmd=${cmd//-sNODERAWFS=1/}

# Node runtime flags. ENVIRONMENT=node so the loader uses fs/worker_threads.
# Keep pthreads (node worker_threads), WASMFS + preload for Blender assets,
# EXIT_RUNTIME=0 so the runtime stays alive for post-render pixel readback.
# PROXY_TO_PTHREAD: run main()/the render on a worker so the node MAIN-thread event
# loop stays free to drive Dawn (@kmamal/gpu) — otherwise the synchronous render
# blocks the event loop and the first GPU op deadlocks. WebGPU calls from the
# render worker are proxied to the main thread where the device lives.
NODE_FLAGS="-pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=0 -g2 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1073741824 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=32 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sFORCE_FILESYSTEM=1 \
  -sMODULARIZE=1 -sEXPORT_NAME=createBlenderModule \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8,HEAPU16,HEAPF32 \
  -sENVIRONMENT=node,worker -sASSERTIONS=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  --preload-file $STAGE/5.3@/5.3 \
  --preload-file $STAGE/python3.13@$SYSROOT/lib/python3.13"

echo ">> relinking blender → $OUT/blender_node.js (node + WebGPU/Dawn/lavapipe)"
( cd "$BUILD" && eval "$cmd $NODE_FLAGS" )
ls -la "$OUT"/blender_node.js "$OUT"/blender_node.wasm "$OUT"/blender_node.data 2>&1
echo ">> done"
