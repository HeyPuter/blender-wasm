#!/usr/bin/env bash
# CPython 3.13.13 → wasm-sysroot (static libpython, embedded into Blender).
# Two-step emscripten cross-build per CPython's Tools/wasm/README.md:
#   1) a native build-python of the SAME version (freezes stdlib during cross-build)
#   2) the wasm cross-build: --enable-wasm-pthreads for the pthread ABI; without
#      it (THREADS=0) CPython's threads are stubs (threading.Thread.start
#      raises). time.sleep stays emscripten's busy wait: Blender's server
#      loop yields through JSPI from C (patches/blender), and a suspension
#      from Python would cross CPython's JS call trampoline, which JSPI
#      cannot suspend through ("trying to suspend JS frames").
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
PYSRC=$(fetch_extract \
  "https://www.python.org/ftp/python/3.13.13/Python-3.13.13.tar.xz" \
  "Python-3.13.13.tar.xz" "Python-3.13.13")
apply_patches python "$PYSRC"

# The bundled mimalloc's internal.h does `#define __wasi__` on Emscripten, and it
# leaks into every core module through pycore_*.h. timemodule.c then takes its
# WASI-only (gh-115714) fallbacks, leaving time.process_time()/times() on clock(),
# which Emscripten doesn't implement -> RuntimeError (breaks e.g. the FBX
# exporter). Emscripten's CPU-time clocks work, so undo the leak in that file.
if ! grep -q "blender-wasm: mimalloc __wasi__ leak" "$PYSRC/Modules/timemodule.c"; then
  python3 - "$PYSRC/Modules/timemodule.c" <<'PYEOF'
import sys
p = sys.argv[1]; s = open(p).read()
anchor = '#include <time.h>                 // clock()\n'
assert anchor in s
s = s.replace(anchor, anchor + (
    '/* blender-wasm: mimalloc __wasi__ leak (see scripts/build_python.sh). */\n'
    '#if defined(__EMSCRIPTEN__) && defined(__wasi__)\n'
    '#  undef __wasi__\n'
    '#endif\n'), 1)
open(p, 'w').write(s)
PYEOF
  log "patched timemodule.c (emscripten CPU-time clocks)"
fi

# 1) Native build-python (host interpreter used by the cross-build).
NATIVE="$BLD/python-native"
# Must be a COMPLETE build (incl. extension modules like binascii) — the wasm
# cross-build runs this interpreter for its freeze/codegen steps.
BUILD_PY="$NATIVE/python"
[ -f "$NATIVE/python.exe" ] && BUILD_PY="$NATIVE/python.exe"

if [ ! -x "$BUILD_PY" ] || ! "$BUILD_PY" -c "import binascii, zlib" 2>/dev/null; then
  log "building native build-python 3.13.13 (full)"
  rm -rf "$NATIVE"; mkdir -p "$NATIVE"; ( cd "$NATIVE"
    "$PYSRC/configure" -C >/dev/null
    make -j"$NPROC" >/dev/null 2>&1 )
  [ -f "$NATIVE/python.exe" ] && BUILD_PY="$NATIVE/python.exe"
fi
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
    HOST_TRIPLET="$(sh "$PYSRC/config.guess")"
    # No JSPI here: the configure tests run their programs, and Blender's
    # link adds -sJSPI.
    PTHREADS_FLAG=--enable-wasm-pthreads; [ "$THREADS" = 0 ] && PTHREADS_FLAG=
    CONFIG_SITE="$PYSRC/Tools/wasm/config.site-wasm32-emscripten" \
    CFLAGS="${ABI_FLAGS/-pthread/} -DPY_CALL_TRAMPOLINE -fPIC" \
    LDFLAGS="$([ "$THREADS" = 0 ] && echo "$ABI_FLAGS")" \
      emconfigure "$PYSRC/configure" -C \
        --host=wasm32-unknown-emscripten \
        --build="$HOST_TRIPLET" \
        $PTHREADS_FLAG \
        --with-build-python="$BUILD_PY" \
        --prefix="$SYSROOT" \
        --disable-shared \
        --disable-test-modules \
        --with-ensurepip=no
  emmake make -j"$NPROC"
  emmake make install )

# The _decimal module's bundled libmpdec objects compile but are NOT archived
# into libpython3.13.a by CPython's static-wasm build, so _decimal.o is left with
# undefined mpd_* symbols at the final Blender link. Fold them into the archive.
# Several bundled modules compile their support sources but CPython's static-wasm
# build does NOT archive them into libpython3.13.a, leaving undefined symbols at
# the final Blender link: _decimal's libmpdec (mpd_*), pyexpat/_elementtree's
# vendored expat (PyExpat_XML_*), and hashlib's HACL SHA2 (python_hashlib_*).
# Fold them in. Prefix member names: libmpdec has context.o/io.o whose BASENAMES
# collide with core CPython objects in the flat-namespaced archive (`ar r` keys
# by basename and would silently overwrite Python's own context.o).
_mz=$(mktemp -d)
for _o in "$WB"/Modules/_decimal/libmpdec/*.o \
          "$WB"/Modules/expat/xmlparse.o "$WB"/Modules/expat/xmltok.o "$WB"/Modules/expat/xmlrole.o \
          "$WB"/Modules/_hacl/Hacl_Hash_SHA2.o; do
  [ -f "$_o" ] && cp "$_o" "$_mz/pymod_$(basename "$_o")"
done
if ls "$_mz"/*.o >/dev/null 2>&1; then
  emar r "$SYSROOT/lib/libpython3.13.a" "$_mz"/*.o
  log "archived bundled libmpdec/expat/hacl objects into libpython3.13.a"
fi
rm -rf "$_mz"

log "installed python into $SYSROOT"
ls -la "$SYSROOT"/lib/libpython3.13*.a 2>&1
