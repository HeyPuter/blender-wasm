#!/usr/bin/env bash
# OpenColorIO 2.5.0 → wasm-sysroot. Uses our pre-built externals (expat,
# yaml-cpp, pystring, minizip-ng, Imath); builds nothing itself. No apps/python.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/AcademySoftwareFoundation/OpenColorIO/archive/v2.5.0.tar.gz" \
  "OpenColorIO-2.5.0.tar.gz" "OpenColorIO-2.5.0")
em_cmake "$src" ocio \
  -DOCIO_INSTALL_EXT_PACKAGES=NONE \
  -DOCIO_BUILD_APPS=OFF \
  -DOCIO_BUILD_TESTS=OFF \
  -DOCIO_BUILD_GPU_TESTS=OFF \
  -DOCIO_BUILD_DOCS=OFF \
  -DOCIO_BUILD_PYTHON=OFF \
  -DOCIO_BUILD_OPENFX=OFF \
  -DOCIO_USE_SSE=OFF \
  -DOCIO_BUILD_FROZEN_DOCS=OFF
log "done"
