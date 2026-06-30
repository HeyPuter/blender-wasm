#!/usr/bin/env bash
# libjpeg-turbo 2.1.3 → wasm-sysroot. SIMD off (no NASM/x86 asm under wasm; the
# portable C paths are used instead).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/libjpeg-turbo/libjpeg-turbo/archive/2.1.3.tar.gz" \
  "libjpeg-turbo-2.1.3.tar.gz" "libjpeg-turbo-2.1.3")
em_cmake "$src" jpeg \
  -DENABLE_SHARED=OFF \
  -DENABLE_STATIC=ON \
  -DWITH_SIMD=OFF \
  -DWITH_TURBOJPEG=OFF
log "done"
