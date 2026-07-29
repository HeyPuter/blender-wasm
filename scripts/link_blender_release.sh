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

# Custom "localdir" wasmfs backend: a real, lazy mount of a folder the user
# picks in the browser (demo/localdir_backend.cpp + demo/localdir_lib.js). It
# reuses emscripten's internal ProxiedAsyncJSBackend, so we compile the .cpp
# against the internal wasmfs headers.
WASMFS_INC="$ROOT/emsdk/upstream/emscripten/system/lib/wasmfs"

WEB_FLAGS="-pthread \
  -sEXIT_RUNTIME=0 -g2 \
  -O1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1073741824 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=32 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sWASMFS -sFORCE_FILESYSTEM=1 \
  -std=c++17 -I$WASMFS_INC $ROOT/demo/localdir_backend.cpp \
  --js-library $ROOT/demo/localdir_lib.js \
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
