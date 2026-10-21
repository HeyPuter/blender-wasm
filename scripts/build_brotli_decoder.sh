#!/usr/bin/env bash
# The page-side brotli decoder (tools/brotli-decode) -> dist/brotli-decode.wasm.
# A standalone module with no imports: pages that receive .br files no server
# decoded (a CDN serving the npm package) stream them through it.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
src=$(ls -d "$ROOT"/deps/src/brotli-* 2>/dev/null | head -1)
[ -n "$src" ] || die "no brotli source in deps/src (./build.sh deps)"
mkdir -p "$DIST"
"$EM_BIN/emcc" -O3 -flto \
  -I"$src/c/include" \
  "$src"/c/common/*.c "$src"/c/dec/*.c "$ROOT/tools/brotli-decode/brotli_decode.c" \
  --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4194304 \
  -sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=1 \
  -o "$DIST/brotli-decode.wasm"
log "built $DIST/brotli-decode.wasm ($(wc -c < "$DIST/brotli-decode.wasm") bytes)"
