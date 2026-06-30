#!/usr/bin/env bash
# OpenEXR 3.4.10 → wasm-sysroot (needs Imath + libdeflate, both in sysroot).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/AcademySoftwareFoundation/openexr/archive/v3.4.10.tar.gz" \
  "openexr-3.4.10.tar.gz" "openexr-3.4.10")

# The Emscripten toolchain reports CMAKE_SYSTEM_PROCESSOR as "x86", so OpenEXR's
# "32-bit x86" block adds `-msse2 -mfpmath=sse` globally. Both are wrong for
# wasm: -mfpmath=sse is rejected outright, and -msse2 defines __SSE2__ which
# pulls in x86 MMX headers (mmintrin.h) emscripten can't compile. Skip the whole
# block under EMSCRIPTEN (idempotent; deps use scalar paths). Vendored OpenJPH
# already takes its own EMSCRIPTEN path.
sed -i 's/MATCHES "\^(i\[3-6\]86|x86)\$" AND NOT MSVC)/MATCHES "^(i[3-6]86|x86)$" AND NOT MSVC AND NOT EMSCRIPTEN)/' \
  "$src/cmake/OpenEXRSetup.cmake"
em_cmake "$src" openexr \
  -DBUILD_TESTING=OFF \
  -DOPENEXR_BUILD_TOOLS=OFF \
  -DOPENEXR_BUILD_EXAMPLES=OFF \
  -DOPENEXR_INSTALL_EXAMPLES=OFF \
  -DOPENEXR_INSTALL_TOOLS=OFF \
  -DOPENEXR_FORCE_INTERNAL_DEFLATE=OFF \
  -DOPENEXR_FORCE_INTERNAL_IMATH=OFF

# Vendored OpenJPH (HTJ2K codec) is built but not installed; OpenEXRCore
# references its symbols, so stage the static lib for the final link.
cp -f "$BLD/openexr/external/OpenJPH/src/core/libopenjph.a" "$SYSROOT/lib/" 2>/dev/null || \
  find "$BLD/openexr" -name 'libopenjph*.a' -exec cp -f {} "$SYSROOT/lib/" \;
log "done"
