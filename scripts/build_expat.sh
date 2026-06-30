#!/usr/bin/env bash
# libexpat 2.7.5 → wasm-sysroot (XML parsing for OpenColorIO/minizip).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/libexpat/libexpat/archive/R_2_7_5.tar.gz" \
  "libexpat-R_2_7_5.tar.gz" "libexpat-R_2_7_5")
# CMake project lives in the expat/ subdir.
em_cmake "$src/expat" expat \
  -DEXPAT_BUILD_TESTS=OFF \
  -DEXPAT_BUILD_EXAMPLES=OFF \
  -DEXPAT_BUILD_TOOLS=OFF \
  -DEXPAT_BUILD_DOCS=OFF \
  -DEXPAT_SHARED_LIBS=OFF
log "done"
