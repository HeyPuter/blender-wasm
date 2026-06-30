#!/usr/bin/env bash
# zstd 1.5.6 → wasm-sysroot (compression, used by OpenEXR/OpenImageIO).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz" \
  "zstd-1.5.6.tar.gz" "zstd-1.5.6")
# zstd's CMake project lives in build/cmake.
em_cmake "$src/build/cmake" zstd \
  -DZSTD_BUILD_SHARED=OFF \
  -DZSTD_BUILD_STATIC=ON \
  -DZSTD_BUILD_PROGRAMS=OFF \
  -DZSTD_BUILD_TESTS=OFF \
  -DZSTD_MULTITHREAD_SUPPORT=ON
log "done"
