#!/usr/bin/env bash
# minizip-ng 4.0.10 → wasm-sysroot (OpenColorIO reads .ocioz zip archives).
# Only zlib/zstd backends; no openssl/bzip2/lzma/iconv/libbsd.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/zlib-ng/minizip-ng/archive/4.0.10.tar.gz" \
  "minizip-ng-4.0.10.tar.gz" "minizip-ng-4.0.10")
em_cmake "$src" minizip \
  -DMZ_BUILD_TESTS=OFF \
  -DMZ_COMPAT=ON \
  -DMZ_OPENSSL=OFF \
  -DMZ_LIBBSD=OFF \
  -DMZ_BZIP2=OFF \
  -DMZ_LZMA=OFF \
  -DMZ_ZSTD=ON \
  -DMZ_ICONV=OFF \
  -DMZ_FETCH_LIBS=OFF \
  -DMZ_PKCRYPT=OFF \
  -DMZ_WZAES=OFF \
  -DMZ_SIGNING=OFF
log "done"
