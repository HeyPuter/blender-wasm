#!/usr/bin/env bash
# oneTBB v2022.3.0 → wasm-sysroot. Threading runtime for Cycles. Emscripten
# pthreads back the worker threads; HWLOC and ITT are disabled.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/uxlfoundation/oneTBB/archive/refs/tags/v2022.3.0.tar.gz" \
  "oneTBB-v2022.3.0.tar.gz" "oneTBB-2022.3.0")
em_cmake "$src" tbb \
  -DTBB_TEST=OFF \
  -DTBB_STRICT=OFF \
  -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON \
  -DTBBMALLOC_BUILD=ON \
  -DTBBMALLOC_PROXY_BUILD=OFF \
  -DTBB_ENABLE_IPO=OFF
log "done"
