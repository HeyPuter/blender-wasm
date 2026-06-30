#!/usr/bin/env bash
# Tessil/robin-map 1.3.0 → wasm-sysroot (header-only; OpenImageIO needs it).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/Tessil/robin-map/archive/refs/tags/v1.3.0.tar.gz" \
  "robinmap-v1.3.0.tar.gz" "robin-map-1.3.0")
em_cmake "$src" robinmap
log "done"
