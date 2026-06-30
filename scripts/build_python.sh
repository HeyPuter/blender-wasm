#!/usr/bin/env bash
# CPython 3.13.13 → wasm-sysroot (static libpython, embedded into Blender).
# Two-step emscripten cross-build per CPython's Tools/wasm/README.md:
#   1) a native build-python of the SAME version (freezes stdlib during cross-build)
#   2) the wasm cross-build with --enable-wasm-pthreads (matches our -pthread ABI)
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
PYSRC=$(fetch_extract \
  "https://www.python.org/ftp/python/3.13.13/Python-3.13.13.tar.xz" \
  "Python-3.13.13.tar.xz" "Python-3.13.13")

# 1) Native build-python (host interpreter used by the cross-build).
NATIVE="$BLD/python-native"
# Must be a COMPLETE build (incl. extension modules like binascii) — the wasm
# cross-build runs this interpreter for its freeze/codegen steps.
if [ ! -x "$NATIVE/python" ] || ! "$NATIVE/python" -c "import binascii, zlib" 2>/dev/null; then
  log "building native build-python 3.13.13 (full)"
  rm -rf "$NATIVE"; mkdir -p "$NATIVE"; ( cd "$NATIVE"
    "$PYSRC/configure" -C >/dev/null
    make -j"$NPROC" >/dev/null 2>&1 )
fi
BUILD_PY="$NATIVE/python"
"$BUILD_PY" --version

# 2) WASM cross-build → $SYSROOT.
WB="$BLD/python-wasm"; rm -rf "$WB"; mkdir -p "$WB"
( cd "$WB"
  # -DPY_CALL_TRAMPOLINE: enable CPython's Emscripten C-function call trampoline.
  # WASM call_indirect enforces exact signature match; CPython calls METH_NOARGS/
  # METH_O C functions through a generic PyCFunctionWithKeywords pointer, which is
  # a bad fpcast that traps ("null function or function signature mismatch") on
  # wasm. The trampoline routes those calls through JS (wasmTable.get + arity
  # reflection) so the real arity is honored. Not auto-defined by 3.13 configure.
  CONFIG_SITE="$PYSRC/Tools/wasm/config.site-wasm32-emscripten" \
  CFLAGS="-fexceptions -DPY_CALL_TRAMPOLINE" \
    emconfigure "$PYSRC/configure" -C \
      --host=wasm32-unknown-emscripten \
      --build=x86_64-pc-linux-gnu \
      --enable-wasm-pthreads \
      --with-build-python="$BUILD_PY" \
      --prefix="$SYSROOT" \
      --disable-shared \
      --disable-test-modules \
      --with-ensurepip=no
  emmake make -j"$NPROC"
  emmake make install )

log "installed python into $SYSROOT"
ls -la "$SYSROOT"/lib/libpython3.13*.a 2>&1
