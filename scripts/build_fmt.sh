#!/usr/bin/env bash
# fmt 12.1.0 → wasm-sysroot (used by OpenImageIO and Blender).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/fmtlib/fmt/archive/refs/tags/12.1.0.tar.gz" \
  "fmt-12.1.0.tar.gz" "fmt-12.1.0")
em_cmake "$src" fmt -DFMT_TEST=OFF -DFMT_DOC=OFF -DFMT_FUZZ=OFF
log "done"
