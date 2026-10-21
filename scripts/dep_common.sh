#!/usr/bin/env bash
# Shared helpers for cross-compiling Blender's dependencies to WASM.
# Sourced by every scripts/build_<dep>.sh. All libs are built static with the
# SAME ABI flags ($ABI_FLAGS from env.sh: pthreads + JS exceptions, or with
# THREADS=0 no pthreads + wasm exceptions) so they link together.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

DL="$DEPS_DOWNLOADS"
SRC="$DEPS/src"
BLD="$DEPS/build"

# ABI-critical flags (-pthread, -fexceptions) MUST match across all objects and
# the final Blender link. SIMD flags only affect codegen, not ABI, so they need
# not match. We deliberately omit -msse4.2 here: it makes emscripten define
# __SSE2__ etc., which pulls in x86 intrinsic headers (mmintrin.h / MMX) that
# emscripten does NOT emulate — breaking OpenEXR/OIIO. Deps fall back to scalar
# paths. Cycles' own kernels can opt into SSE separately at the Blender stage.
# -fexceptions (emscripten JS-based exceptions + setjmp/longjmp). NOT
# -fwasm-exceptions: native wasm SjLj corrupts the heap when Blender's Tint
# GLSL->WGSL ICE-recovery longjmp fires (some EEVEE shaders Tint can't translate).
# The GPU readback is deferred (copy-to-buffer + map after render), so it does not
# need JSPI/wasm-EH. Keep this identical across every object (deps + Blender).
# -fPIC: the headless build links -sMAIN_MODULE (so CPython can dlopen numpy's
# side modules), which requires every input to be position-independent. PIC
# objects link into the static browser builds just as well, so one sysroot
# serves every flavour.
WASM_CFLAGS="${WASM_CFLAGS:--O2 $ABI_FLAGS -msimd128 -fPIC}"
WASM_CXXFLAGS="${WASM_CXXFLAGS:-$WASM_CFLAGS}"

mkdir -p "$DL" "$SRC" "$BLD" "$SYSROOT"

# log() comes from env.sh and writes to stderr: fetch_extract returns its path
# on stdout via `echo`, so log output must not pollute that captured value.

# fetch_extract <url> <tarball-name> <expected-extracted-dirname>
fetch_extract() {
  local url="$1" file="$2" dir="$3"
  if [ ! -f "$DL/$file" ]; then
    log "downloading $file"
    curl -fL --retry 3 -o "$DL/$file.tmp" "$url"
    mv "$DL/$file.tmp" "$DL/$file"
  fi
  if [ ! -d "$SRC/$dir" ]; then
    log "extracting $file"
    tar -C "$SRC" -xf "$DL/$file"
  fi
  echo "$SRC/$dir"
}

# apply_patches <name> <srcdir>
# Applies patches/<name>/*.patch to a dependency's source. They are guarded
# for the build they serve (e.g. emscripten without pthreads), so they apply
# in every flavour; -N skips one already applied.
apply_patches() {
  local name="$1" srcdir="$2" p
  for p in "$ROOT/patches/$name"/*.patch; do
    [ -f "$p" ] || continue
    patch -d "$srcdir" -p1 -N -r - --silent < "$p" || log "$(basename "$p"): already applied"
  done
}

# em_cmake <srcdir> <builddir-name> [extra cmake -D args...]
# Configures + builds + installs a CMake project into $SYSROOT.
em_cmake() {
  local srcdir="$1" name="$2"; shift 2
  local b="$BLD/$name"
  rm -rf "$b"
  emcmake cmake -S "$srcdir" -B "$b" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
    -DCMAKE_PREFIX_PATH="$SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_C_FLAGS="$WASM_CFLAGS" \
    -DCMAKE_CXX_FLAGS="$WASM_CXXFLAGS" \
    "$@"
  ninja -C "$b" -j"$NPROC"
  ninja -C "$b" install
  log "installed $name into $SYSROOT"
}
