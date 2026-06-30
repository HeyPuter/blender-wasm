#!/usr/bin/env bash
# libtiff 4.7.1 → wasm-sysroot. OpenImageIO needs tiff.h for its EXIF/ICC tag
# handling even when the TIFF reader is disabled. Minimal codecs (zlib + zstd +
# jpeg, all already in the sysroot); no tools/tests/docs.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://download.osgeo.org/libtiff/tiff-4.7.1.tar.gz" \
  "tiff-4.7.1.tar.gz" "tiff-4.7.1")
em_cmake "$src" tiff \
  -Dtiff-tools=OFF \
  -Dtiff-tests=OFF \
  -Dtiff-docs=OFF \
  -Dtiff-contrib=OFF \
  -Dlzma=OFF -Djbig=OFF -Dlerc=OFF -Dwebp=OFF -Dzstd=ON \
  -Dlibdeflate=ON
log "done"
