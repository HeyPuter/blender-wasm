#!/usr/bin/env bash
# Imath 3.2.2 → wasm-sysroot (math types for OpenEXR/OpenImageIO).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/AcademySoftwareFoundation/Imath/archive/v3.2.2.tar.gz" \
  "imath-3.2.2.tar.gz" "Imath-3.2.2")
em_cmake "$src" imath \
  -DBUILD_TESTING=OFF \
  -DIMATH_INSTALL_PKG_CONFIG=ON \
  -DPYTHON=OFF
log "done"
