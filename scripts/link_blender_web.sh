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
source "$(dirname "${BASH_SOURCE[0]}")/link_common.sh"
WEB="${OUT:-$ROOT/web}"
STAGE="$WEB/blender_assets"
LINK_OPT="${LINK_OPT:--O1}"
mkdir -p "$WEB"

# --- stage runtime assets (trimmed CPython stdlib, see link_common.sh) -----
stage_assets "$STAGE" python3.13
stage_cycles_addon "$STAGE"
# OCIO diet: a browser canvas is an sRGB display — drop the P3/Rec.2020/
# Rec.2100 display definitions and their (multi-MB) AgX cubes, plus the
# niche Khronos PBR Neutral view. AgX_Base_Rec2020.cube STAYS: the kept
# False Color view transform samples it. config.ocio is patched in staging
# only (source tree untouched).
python3 "$ROOT/scripts/trim_ocio.py" "$STAGE/$BLENDER_VERSION_DIR/datafiles/colormanagement"
precompile_python "$STAGE/$BLENDER_VERSION_DIR/scripts" "$STAGE/python3.13"
log "scripts=$(du -shL "$STAGE/$BLENDER_VERSION_DIR/scripts"|cut -f1) datafiles=$(du -shL "$STAGE/$BLENDER_VERSION_DIR/datafiles"|cut -f1) py=$(du -sh "$STAGE/python3.13"|cut -f1)"

cmd=$(cmake_link_cmd "$WEB/blender.js")

# Web runtime flags. PROXY_TO_PTHREAD: Blender's main + worker pthreads run off
# the browser UI thread. WASMFS keeps the file store in shared memory so the
# render output written on the proxied-main worker is readable from the UI
# thread. Preload Blender's scripts/datafiles at /5.3 and CPython at its compiled
# prefix path. callMain/FS exported so JS can run the CLI and read results back.
#
# Readback architecture: render on the browser main thread. GPU->host readback is
# DEFERRED, not synchronous — synchronous readback is impossible here because JSPI
# can't suspend through CPython's C-call trampoline (a JS frame present throughout
# the Python-driven render). Instead WebGPUContext::read_color_sync copies the
# composited combined texture into a persistent buffer during the render; after
# the render call returns and the browser event loop is free, JS maps that buffer
# (wgpu_capture_map) and reads the pixels. No JSPI, no suspend.
# NOTE: -sJSPI was tried for synchronous GPU readbacks (click-select) and is a
# NON-STARTER with -fexceptions: emscripten wraps ALL invoke_* trampolines as
# WebAssembly.Suspending, and every entry into wasm that is not a promising
# export (static ctors, html5 event callbacks, main-loop ticks) throws
# SuspendError on the first exception-guarded call. Select readback needs a
# different design (CPU raycast fallback or cached async readback).
# CPython's archive carries its own expat (build_python.sh folds pyexpat's
# objects in) and OpenImageIO pulls the standalone libexpat: the first
# definition is taken, as in link_blender_headless.sh.
# $GL: emscripten 6 asserts at startup that OFFSCREENCANVAS_SUPPORT has the GL
# library linked, which a WebGPU-only build otherwise drops (the canvas
# transfer to the render pthread then aborts). Quoted to survive the eval.
# --use-port=emdawnwebgpu: the WebGPU bindings (wgpuCreateInstance, ...). The
# gpu module compiles with the port, but nothing puts it on CMake's link line,
# and without it the backend aborts at startup on a missing function.
WEB_FLAGS="-pthread \
  -Wl,--allow-multiple-definition \
  -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='\$GL' \
  --use-port=emdawnwebgpu \
  -sEXIT_RUNTIME=0 -g2 \
  $LINK_OPT \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1073741824 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=32 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sWASMFS -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8,HEAPU16,HEAPF32 \
  -sENVIRONMENT=web,worker -sASSERTIONS=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  --preload-file $STAGE/$BLENDER_VERSION_DIR@/$BLENDER_VERSION_DIR \
  --preload-file $STAGE/python3.13@$SYSROOT/lib/python3.13"

echo ">> relinking blender → $WEB/blender.js (web + WebGPU)"
( cd "$BLENDER_BUILD" && eval "$cmd $EXTRA_LINK_LIBS $WEB_FLAGS" )

ls -la "$WEB"/blender.js "$WEB"/blender.wasm "$WEB"/blender.data 2>&1
echo ">> done"
