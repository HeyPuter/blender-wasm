#!/usr/bin/env bash
# libpng 1.6.58 → wasm-sysroot (needs zlib). Hardware SIMD optimizations off.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/pnggroup/libpng/archive/refs/tags/v1.6.58.tar.gz" \
  "libpng-1.6.58.tar.gz" "libpng-1.6.58")
em_cmake "$src" png \
  -DPNG_SHARED=OFF \
  -DPNG_STATIC=ON \
  -DPNG_TESTS=OFF \
  -DPNG_TOOLS=OFF \
  -DPNG_HARDWARE_OPTIMIZATIONS=OFF \
  -DZLIB_ROOT="$SYSROOT"
log "done"
