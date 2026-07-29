#!/usr/bin/env bash
# Release/demo link: like link_blender_web.sh but with NO --preload-file —
# the demo app (demo/) extracts assets into OPFS once (setup screen) and the
# wasm mounts them via the wasmfs OPFS backend (BLENDER_WEB_OPFS env, see
# creator.cc). Outputs into demo/public/:
#   blender.js            emscripten glue (loads wasm via Module.instantiateWasm)
#   blender.wasm.zst      zstd --ultra -21 of the wasm
#   assets.tar.zst        5.3/ + lib/python3.13/ (PYTHONHOME=/opfs/assets)
#   wgsl-cache.json       pre-seeded shader translations (copied from web/)
# The dev fast-path (link_blender_web.sh) is untouched and skips zstd.
set -euo pipefail
ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PATH="$ROOT/emsdk/upstream/emscripten:$PATH"
BUILD="$ROOT/build-blender"
OUT="$ROOT/demo/public"
SYSROOT="$ROOT/wasm-sysroot"
STAGE="$ROOT/demo/.stage"

mkdir -p "$OUT"

# --- stage runtime assets (same trims as the dev script) --------------------
echo ">> staging assets -> $STAGE"
rm -rf "$STAGE"; mkdir -p "$STAGE/5.3" "$STAGE/lib"
cp -r "$ROOT/blender/scripts"           "$STAGE/5.3/scripts"
cp -r "$ROOT/blender/release/datafiles" "$STAGE/5.3/datafiles"
# Python under lib/python3.13 so PYTHONHOME=/opfs/assets resolves the stdlib.
cp -r "$SYSROOT/lib/python3.13" "$STAGE/lib/python3.13"
( cd "$STAGE/lib/python3.13" && rm -rf test tests idlelib lib2to3 turtledemo tkinter \
    config-3.13-wasm32-emscripten ensurepip \
    && find . -name '__pycache__' -type d -prune -exec rm -rf {} + )
rm -f "$STAGE/5.3/datafiles/splash_template.xcf"
python3 "$ROOT/scripts/trim_ocio.py" "$STAGE/5.3/datafiles/colormanagement"

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
  ASSETS_DST="$STAGE/5.3/datafiles/assets"
  sculpt_name="brushes/essentials_brushes-mesh_sculpt.blend"
  ASSETS_SRC=""
  for cand in \
      "$ROOT/demo/brush-assets" \
      "$ROOT/blender/assets" \
      $(ls -d "$ROOT"/tests/native/blender-*/5.3/datafiles/assets 2>/dev/null | head -1); do
    if [ -n "$cand" ] && [ "$(stat -c%s "$cand/$sculpt_name" 2>/dev/null || echo 0)" -ge 1024 ]; then
      ASSETS_SRC="$cand"; break
    fi
  done
  # Last resort for a dev checkout: materialize the LFS content in blender/assets.
  if [ -z "$ASSETS_SRC" ] && [ -e "$ROOT/blender/assets/$sculpt_name" ]; then
    ( cd "$ROOT/blender" && git lfs pull --include="assets/brushes/**" ) 2>/dev/null || true
    [ "$(stat -c%s "$ROOT/blender/assets/$sculpt_name" 2>/dev/null || echo 0)" -ge 1024 ] && \
      ASSETS_SRC="$ROOT/blender/assets"
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
echo ">> assets.tar.zst (zstd --ultra -21 -T0)"
( cd "$STAGE" && tar -cf "$OUT/assets.tar" 5.3 lib )
zstd -f --ultra -21 -T0 "$OUT/assets.tar" -o "$OUT/assets.tar.zst"
rm -f "$OUT/assets.tar"

# --- link without preload ----------------------------------------------------
raw=$(ninja -C "$BUILD" -t commands blender | grep -- "-o bin/blender.js" | tail -1)
cmd=${raw#*&& }
cmd=${cmd%% && cd *}
cmd=${cmd/-o bin\/blender.js/-o $OUT/blender.js}
cmd=${cmd//-sNODERAWFS=1/}

# Custom wasmfs backends (compiled against emscripten's internal wasmfs headers):
#  - localdir_backend.cpp: lazy async mount of a user-picked folder (open/save).
#  - provider_backend.cpp + provider-fs.js: gecko-wasm's FsProvider backend,
#    verbatim — serves /assets from the in-memory decompressed tar
#    (Module.geckoProviders[0], built in demo/src/main.js). Zero-copy: files are
#    views into the one decompressed buffer, materialized on open.
WASMFS_INC="$ROOT/emsdk/upstream/emscripten/system/lib/wasmfs"

WEB_FLAGS="-pthread \
  -sEXIT_RUNTIME=0 -g2 \
  -O1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1073741824 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=32 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sPROXY_TO_PTHREAD=1 \
  -sOFFSCREENCANVAS_SUPPORT=1 -sOFFSCREENCANVASES_TO_PTHREAD=#canvas \
  -sWASMFS -sFORCE_FILESYSTEM=1 \
  -std=c++17 -I$WASMFS_INC $ROOT/demo/localdir_backend.cpp $ROOT/demo/provider_backend.cpp \
  --js-library $ROOT/demo/localdir_lib.js \
  --js-library $ROOT/demo/provider-fs.js \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8,HEAPU16,HEAPF32 \
  -sENVIRONMENT=web,worker -sASSERTIONS=1 -sERROR_ON_UNDEFINED_SYMBOLS=0"

echo ">> relinking blender → $OUT/blender.js (release, no preload)"
( cd "$BUILD" && eval "$cmd $WEB_FLAGS" )

echo ">> blender.wasm.zst (zstd --ultra -21 -T0)"
zstd -f --ultra -21 -T0 "$OUT/blender.wasm" -o "$OUT/blender.wasm.zst"
rm -f "$OUT/blender.wasm"

cp -f "$ROOT/web/wgsl-cache.json" "$OUT/wgsl-cache.json" 2>/dev/null || true

# Manifest with decompressed sizes (zstddec wants explicit sizes).
python3 - "$OUT" <<'PYEOF'
import json
import os
import subprocess
import sys
out = sys.argv[1]
sizes = {}
for name in ("blender.wasm.zst", "assets.tar.zst"):
    r = subprocess.run(["zstd", "-lv", os.path.join(out, name)], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if "Decompressed Size" in line:
            sizes[name] = int(line.split("(")[1].split()[0].replace(",", ""))
open(os.path.join(out, "manifest.json"), "w").write(json.dumps(sizes))
print("manifest:", sizes)
PYEOF

ls -la "$OUT"
echo ">> done"
