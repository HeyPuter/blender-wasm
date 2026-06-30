#!/usr/bin/env bash
# OpenImageIO v3.1.13.1 → wasm-sysroot. Minimal: only PNG/JPEG/OpenEXR readers,
# no tools/tests/python/GL, no optional format libs we didn't cross-compile.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/AcademySoftwareFoundation/OpenImageIO/archive/refs/tags/v3.1.13.1.tar.gz" \
  "OpenImageIO-v3.1.13.1.tar.gz" "OpenImageIO-3.1.13.1")

# OIIO's platform detection keys on __linux__, which emscripten does not define
# (it defines __EMSCRIPTEN__). Emscripten's libc is musl-like and provides the
# needed APIs (unistd, usleep, isatty, strcasecmp_l), so treat emscripten as
# Linux throughout. Idempotent via sentinel.
if [ ! -f "$src/.wasm_linux_patched" ]; then
  grep -rlZ '__linux__' "$src/src" | xargs -0 --no-run-if-empty sed -i \
    -e 's/defined(__linux__)/(defined(__linux__) || defined(__EMSCRIPTEN__))/g'
  grep -rlZ '#ifdef __linux__' "$src/src" | xargs -0 --no-run-if-empty sed -i \
    -e 's/#ifdef __linux__/#if defined(__linux__) || defined(__EMSCRIPTEN__)/g'
  touch "$src/.wasm_linux_patched"
fi

em_cmake "$src" oiio \
  -DCMAKE_CXX_STANDARD=17 \
  -DLINKSTATIC=ON \
  -DOIIO_BUILD_TESTS=OFF \
  -DOIIO_BUILD_TOOLS=OFF \
  -DBUILD_DOCS=OFF \
  -DINSTALL_DOCS=OFF \
  -DUSE_PYTHON=OFF \
  -DUSE_QT=OFF \
  -DUSE_OPENGL=OFF \
  -DUSE_FREETYPE=OFF \
  -DUSE_OPENCV=OFF \
  -DUSE_TBB=OFF \
  -DUSE_BZIP2=OFF \
  -DBUILD_MISSING_DEPS=OFF \
  -DBUILD_MISSING_ROBINMAP=OFF \
  -DBUILD_MISSING_FMT=OFF \
  -DSTOP_ON_WARNING=OFF \
  -DENABLE_PNG=ON \
  -DENABLE_JPEG=ON \
  -DENABLE_OpenEXR=ON \
  -DENABLE_TIFF=OFF -DENABLE_GIF=OFF -DENABLE_FFMPEG=OFF -DENABLE_HEIF=OFF \
  -DENABLE_Raw=OFF -DENABLE_WebP=OFF -DENABLE_OpenJPEG=OFF -DENABLE_Ptex=OFF \
  -DENABLE_DICOM=OFF -DENABLE_Field3D=OFF -DENABLE_OpenVDB=OFF -DENABLE_DDS=OFF \
  -DENABLE_R3DSDK=OFF -DENABLE_Nuke=OFF -DENABLE_LIBHEIF=OFF \
  -DENABLE_BZip2=OFF -DENABLE_Libsquish=ON
log "done"
