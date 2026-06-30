#!/usr/bin/env bash
# libdeflate 1.18 → wasm-sysroot (OpenEXR 3.4 uses it for zip compression).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/ebiggers/libdeflate/archive/refs/tags/v1.18.tar.gz" \
  "libdeflate-v1.18.tar.gz" "libdeflate-1.18")
em_cmake "$src" libdeflate \
  -DLIBDEFLATE_BUILD_SHARED_LIB=OFF \
  -DLIBDEFLATE_BUILD_STATIC_LIB=ON \
  -DLIBDEFLATE_BUILD_GZIP=OFF
log "done"
