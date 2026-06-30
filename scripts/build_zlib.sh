#!/usr/bin/env bash
# zlib 1.3.1 → wasm-sysroot. Smallest dep; validates the cross-compile pattern.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"

src=$(fetch_extract \
  "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz" \
  "zlib-1.3.1.tar.gz" "zlib-1.3.1")

em_cmake "$src" zlib \
  -DZLIB_BUILD_EXAMPLES=OFF

# zlib's CMake installs shared libz.so* regardless of BUILD_SHARED_LIBS. Remove
# them so downstream links resolve to the static libz.a only (emscripten static).
rm -f "$SYSROOT"/lib/libz.so*
log "done"
