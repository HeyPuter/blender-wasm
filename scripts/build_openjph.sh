#!/usr/bin/env bash
# OpenJPH 0.26.3 → wasm-sysroot (standalone, WITH its CMake config package).
# OpenEXR 3.4 needs this as an external dependency: when it's vendored-internal,
# OpenEXR's installed config still references an `openjph` target that nothing
# provides, which breaks downstream find_package(OpenEXR) in OIIO. OpenJPH's own
# CMake already takes a correct EMSCRIPTEN path (wasm SIMD, no x86 intrinsics).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/aous72/OpenJPH/archive/refs/tags/0.26.3.tar.gz" \
  "openjph-0.26.3.tar.gz" "OpenJPH-0.26.3")
em_cmake "$src" openjph \
  -DOJPH_BUILD_EXECUTABLES=OFF \
  -DOJPH_BUILD_TESTS=OFF \
  -DOJPH_ENABLE_TIFF_SUPPORT=OFF
log "done"
