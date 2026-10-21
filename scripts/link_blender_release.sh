#!/usr/bin/env bash
# Release/demo link: like link_blender_web.sh but with NO --preload-file —
# (OPTIMIZE=1 runs scripts/optimize_wasm.sh on the module before compressing it.)
# the demo app (demo/) extracts assets into OPFS once (setup screen) and the
# wasm mounts them via the wasmfs OPFS backend (BLENDER_WEB_OPFS env, see
# creator.cc). Outputs into demo/public/:
#   blender.js            emscripten glue (loads wasm via Module.instantiateWasm)
#   blender.wasm.zst      zstd --ultra -21 of the wasm
#   assets.tar.zst        5.3/ + lib/python3.13/ (PYTHONHOME=/opfs/assets)
#   wgsl-cache.json       pre-seeded shader translations (copied from web/)
# The dev fast-path (link_blender_web.sh) is untouched and skips zstd.
#
# BLENDER_GPU selects the graphics stack the build tree was configured for:
#   gl     (default) OpenGL backend on wink — Mesa's GL on WebGPU
#          (cmake/blender-wasm-gl-cache.cmake, build tree build-blender-gl).
#          The canvas stays on the browser main thread, where wink runs the
#          driver; Blender's pthreads marshal GL to it (no OffscreenCanvas).
#   webgpu the custom WebGPU GPU backend (cmake/blender-wasm-cache.cmake,
#          build tree build-blender; `./build.sh web` passes this); the canvas
#          is transferred to the Blender pthread as an OffscreenCanvas.
# BLENDER_BUILD (or BUILD) overrides the build tree either way.
set -euo pipefail
BLENDER_GPU="${BLENDER_GPU:-gl}"
case "$BLENDER_GPU" in
  gl)     BLENDER_BUILD="${BLENDER_BUILD:-${BUILD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build-blender-gl}}" ;;
  webgpu) BLENDER_BUILD="${BLENDER_BUILD:-${BUILD:-}}" ;;
  *) echo "BLENDER_GPU must be gl or webgpu" >&2; exit 1 ;;
esac
[ -n "$BLENDER_BUILD" ] && export BLENDER_BUILD || unset BLENDER_BUILD
source "$(dirname "${BASH_SOURCE[0]}")/link_common.sh"
OUT="${OUT:-$ROOT/demo/public}"
STAGE="$ROOT/demo/.stage"
LINK_OPT="${LINK_OPT:--O1}"
ZSTD_LEVEL="${ZSTD_LEVEL:-21}"

mkdir -p "$OUT"

# --- stage runtime assets ------------------------------------------------------
# Python under lib/python3.13 so PYTHONHOME=/opfs/assets resolves the stdlib.
stage_assets "$STAGE" lib/python3.13
stage_cycles_addon "$STAGE"
python3 "$ROOT/scripts/trim_ocio.py" "$STAGE/$BLENDER_VERSION_DIR/datafiles/colormanagement"
precompile_python "$STAGE/$BLENDER_VERSION_DIR/scripts" "$STAGE/lib/python3.13"

# --- essentials brush assets -> 5.3/datafiles/assets/brushes -----------------
# Blender 4.3+ ships sculpt/paint brushes as ID *assets* in the bundled
# "essentials" library, resolved at runtime from <datafiles>/assets (see
# essentials_directory_path()). Without them BKE_paint_brush() stays null and
# sculpt/paint strokes have NO effect (the Brush Asset panel is empty). The
# blends live in blender/assets/ (git-lfs); we only need brushes/ for
# sculpt+paint (skip the larger nodes/ asset libraries).
#
# On by default. (Bundling these 64-bit-authored blends once tripped a wasm32
# blend-read bug when the asset library was indexed — blo_bhead_id_asset_data_address
# read the asset_data pointer at the reader's width, truncating the file's
# 64-bit value and crashing; that's fixed in readfile.cc.) Set
# BLENDER_WEB_BUNDLE_BRUSHES=0 to skip bundling (smaller download, no brushes).
#
# Source resolution: the brush blends are NOT hosted on any anonymous git-LFS
# (they 404 on every fork's GitHub LFS and are auth-gated upstream), so the
# canonical source is the in-repo VENDORED copy (demo/brush-assets/), which is
# always present in CI. Fall back to blender/assets (dev checkout with LFS) or
# the on-disk native reference only if the vendored copy is somehow missing.
if [ "${BLENDER_WEB_BUNDLE_BRUSHES:-1}" != "0" ]; then
  ASSETS_DST="$STAGE/$BLENDER_VERSION_DIR/datafiles/assets"
  sculpt_name="brushes/essentials_brushes-mesh_sculpt.blend"
  ASSETS_SRC=""
  for cand in \
      "$ROOT/demo/brush-assets" \
      "$BLENDER_SRC/assets" \
      $(ls -d "$ROOT"/tests/native/blender-*/"$BLENDER_VERSION_DIR"/datafiles/assets 2>/dev/null | head -1); do
    if [ -n "$cand" ] && [ "$(stat -c%s "$cand/$sculpt_name" 2>/dev/null || echo 0)" -ge 1024 ]; then
      ASSETS_SRC="$cand"; break
    fi
  done
  # Last resort for a dev checkout: materialize the LFS content in blender/assets.
  if [ -z "$ASSETS_SRC" ] && [ -e "$BLENDER_SRC/assets/$sculpt_name" ]; then
    ( cd "$BLENDER_SRC" && git lfs pull --include="assets/brushes/**" ) 2>/dev/null || true
    [ "$(stat -c%s "$BLENDER_SRC/assets/$sculpt_name" 2>/dev/null || echo 0)" -ge 1024 ] && \
      ASSETS_SRC="$BLENDER_SRC/assets"
  fi
  echo ">> brush asset source: ${ASSETS_SRC:-<none found>}"
  sculpt_blend="$ASSETS_SRC/$sculpt_name"
  if [ "$(stat -c%s "$sculpt_blend" 2>/dev/null || echo 0)" -lt 1024 ]; then
    # Still unresolved (LFS pointers): do NOT copy — bundling 131-byte pointer
    # stubs would ship broken "blends". Skip cleanly; the demo boots without
    # brushes (sculpt/paint disabled) rather than shipping garbage.
    echo "!! WARNING: essentials brush assets unresolved (LFS pointers) — NOT bundling; sculpt/paint disabled"
  else
    mkdir -p "$ASSETS_DST/brushes"
    cp -f "$ASSETS_SRC/blender_assets.cats.txt" "$ASSETS_DST/"        2>/dev/null || true
    cp -f "$ASSETS_SRC/LICENSE"                 "$ASSETS_DST/"        2>/dev/null || true
    cp -f "$ASSETS_SRC"/brushes/*.blend         "$ASSETS_DST/brushes/" 2>/dev/null || true
    echo ">> staged essentials brushes ($(ls "$ASSETS_DST"/brushes/*.blend | wc -l) blends)"
  fi
else
  echo ">> brush assets NOT bundled (BLENDER_WEB_BUNDLE_BRUSHES=0) — sculpt/paint brushes disabled"
fi

# --- assets.tar.zst ----------------------------------------------------------
log "assets.tar.zst (zstd --ultra -$ZSTD_LEVEL -T0)"
( cd "$STAGE" && tar -cf "$OUT/assets.tar" "$BLENDER_VERSION_DIR" lib )
zstd -f --ultra -"$ZSTD_LEVEL" -T0 "$OUT/assets.tar" -o "$OUT/assets.tar.zst"
rm -f "$OUT/assets.tar"

# --- link without preload ----------------------------------------------------
cmd=$(cmake_link_cmd "$OUT/blender.js")

# Custom wasmfs backends (compiled against emscripten's internal wasmfs headers):
#  - localdir_backend.cpp: lazy async mount of a user-picked folder (open/save).
#  - provider_backend.cpp + provider-fs.js: gecko-wasm's FsProvider backend,
#    verbatim — serves /assets from the in-memory decompressed tar
#    (Module.geckoProviders[0], built in demo/src/main.js). Zero-copy: files are
#    views into the one decompressed buffer, materialized on open.
WASMFS_INC="$EM_BIN/system/lib/wasmfs"

if [ "$BLENDER_GPU" = gl ]; then
  # wink: Mesa (st/mesa + gex_wgpu + GLSL/NIR), emdawnwebgpu's webgpu.cpp and
  # Tint, plus their JS libraries in the order wink's manifest lists them.
  # (scripts/build_wink.sh.) The build tree's CMAKE_EXE_LINKER_FLAGS are empty,
  # so the extra system ports / libs the WebGPU tree carried there come here
  # (brotli comes with EXTRA_LINK_LIBS).
  WINK="$SYSROOT/wink"
  GPU_FLAGS="$WINK/lib/libwink.a $WINK/lib/libwink_webgpu.a $WINK/lib/libwink_tint.a \
    $(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(" ".join("--js-library "+sys.argv[2]+"/"+j for j in m["link"]["js_libraries"]))' "$WINK/manifest.json" "$WINK") \
    -sWASM_BIGINT=1 \
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free \
    --use-port=sqlite3 --use-port=bzip2 \
    $ROOT/cmake/stubs/extra_stubs.o"
else
  # $GL: emscripten 6 asserts at startup that OFFSCREENCANVAS_SUPPORT has the GL
  # library linked, which a WebGPU-only build otherwise drops (the canvas
  # transfer to the render pthread then aborts). Quoted to survive the eval.
  # --use-port=emdawnwebgpu: the WebGPU bindings (wgpuCreateInstance, ...). The
  # gpu module compiles with the port, but nothing puts it on CMake's link line,
  # and without it the backend aborts at startup on a missing function.
  GPU_FLAGS="-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='\$GL' --use-port=emdawnwebgpu \
    -sOFFSCREENCANVAS_SUPPORT=1 -sOFFSCREENCANVASES_TO_PTHREAD=#canvas"
fi

# CPython's archive carries its own expat (build_python.sh folds pyexpat's
# objects in) and OpenImageIO pulls the standalone libexpat: the first
# definition is taken, as in link_blender_headless.sh.
WEB_FLAGS="-pthread \
  -Wl,--allow-multiple-definition \
  -sEXIT_RUNTIME=0 -g2 \
  $LINK_OPT \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1073741824 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=32 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sPROXY_TO_PTHREAD=1 \
  $GPU_FLAGS \
  -sWASMFS -sFORCE_FILESYSTEM=1 \
  -std=c++17 -I$WASMFS_INC $ROOT/demo/localdir_backend.cpp $ROOT/demo/provider_backend.cpp \
  --js-library $ROOT/demo/localdir_lib.js \
  --js-library $ROOT/demo/provider-fs.js \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8,HEAPU16,HEAPU32,HEAPF32 \
  -sENVIRONMENT=web,worker -sASSERTIONS=1 -sERROR_ON_UNDEFINED_SYMBOLS=0"

# NumPy as builtin modules (scripts/build_numpy.sh): the constructor in
# numpy_inittab.o registers them and pulls the extension objects from the
# archive. Its Python package ships in assets via lib/python3.13/site-packages.
if [ -f "$SYSROOT/lib/numpy_inittab.o" ]; then
  WEB_FLAGS="$WEB_FLAGS $SYSROOT/lib/numpy_inittab.o $SYSROOT/lib/libnumpy.a"
else
  echo "!! WARNING: numpy not built (scripts/build_numpy.sh) — add-ons that import numpy (glTF, FBX, ...) will fail"
fi

echo ">> relinking blender → $OUT/blender.js (release, no preload)"
( cd "$BLENDER_BUILD" && eval "$cmd $EXTRA_LINK_LIBS $WEB_FLAGS" )

if [ "${OPTIMIZE:-0}" = 1 ]; then
  bash "$ROOT/scripts/optimize_wasm.sh" "$OUT/blender.wasm"
  rm -f "$OUT/blender.unopt.wasm"
fi

log "blender.wasm.zst (zstd --ultra -$ZSTD_LEVEL -T0)"
zstd -f --ultra -"$ZSTD_LEVEL" -T0 "$OUT/blender.wasm" -o "$OUT/blender.wasm.zst"
rm -f "$OUT/blender.wasm"

if [ "$BLENDER_GPU" = gl ]; then
  # wink's SPIR-V -> WGSL translations for the shaders the common paths use
  # (made by `DUMP_WGSL=demo/wgsl-cache-gl.bin TAG=dump node
  # scripts/compat_suite.mjs demo/dist`, then zstd -19). wink refuses a blob
  # from a different Tint build whole, so a stale one only costs its download.
  cp -f "$ROOT/demo/wgsl-cache-gl.bin.zst" "$OUT/wgsl-cache-gl.bin.zst" 2>/dev/null || true
else
  rm -f "$OUT/wgsl-cache-gl.bin.zst"
  cp -f "$ROOT/web/wgsl-cache.json" "$OUT/wgsl-cache.json" 2>/dev/null || true
fi

# Manifest with decompressed sizes (zstddec wants explicit sizes).
python3 - "$OUT" <<'PYEOF'
import json
import os
import subprocess
import sys
out = sys.argv[1]
sizes = {}
for name in ("blender.wasm.zst", "assets.tar.zst", "wgsl-cache-gl.bin.zst"):
    if not os.path.exists(os.path.join(out, name)):
        continue
    r = subprocess.run(["zstd", "-lv", os.path.join(out, name)], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if "Decompressed Size" in line:
            sizes[name] = int(line.split("(")[1].split()[0].replace(",", ""))
open(os.path.join(out, "manifest.json"), "w").write(json.dumps(sizes))
print("manifest:", sizes)
PYEOF

ls -la "$OUT"
echo ">> done"
