#!/usr/bin/env bash
# pystring 1.1.3 → wasm-sysroot. No CMake upstream (just one .cpp/.h), so build
# the static lib by hand and install a Findpystring-compatible layout that
# OpenColorIO can locate (header at include/pystring/pystring.h).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://codeload.github.com/imageworks/pystring/tar.gz/refs/tags/v1.1.3" \
  "pystring-v1.1.3.tar.gz" "pystring-1.1.3")

b="$BLD/pystring"; rm -rf "$b"; mkdir -p "$b"
em++ $WASM_CXXFLAGS -c "$src/pystring.cpp" -o "$b/pystring.o"
emar rcs "$b/libpystring.a" "$b/pystring.o"
install -Dm644 "$b/libpystring.a" "$SYSROOT/lib/libpystring.a"
install -Dm644 "$src/pystring.h"  "$SYSROOT/include/pystring/pystring.h"
log "installed pystring into $SYSROOT"
