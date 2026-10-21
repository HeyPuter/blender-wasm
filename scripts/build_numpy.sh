#!/usr/bin/env bash
# NumPy (Blender's pinned 2.3.4) → wasm-sysroot, STATICALLY linked into Blender.
# Many bundled add-ons import numpy (glTF, FBX, ...), but our wasm build has no
# dlopen, so the C extension modules can't be loaded from .so files. Instead:
#   1) cross-compile numpy with its vendored meson (emcc, no BLAS/LAPACK — the
#      bundled lapack_lite — and no SIMD dispatch),
#   2) archive every extension module's objects into lib/libnumpy.a,
#   3) generate lib/numpy_inittab.o, whose constructor registers each module as
#      a dotted *builtin* (PyImport_ExtendInittab before Py_Initialize). The
#      import system's BuiltinImporter resolves e.g. "numpy._core._multiarray_umath"
#      before the path finder looks in the numpy package,
#   4) install the pure-Python part (minus tests / stub .so) to
#      lib/python3.13/site-packages/numpy, staged by link_blender_release.sh.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
NPV=2.3.4
NPSRC=$(fetch_extract \
  "https://github.com/numpy/numpy/releases/download/v$NPV/numpy-$NPV.tar.gz" \
  "numpy-$NPV.tar.gz" "numpy-$NPV")

# Host interpreter: the native CPython of the SAME version as the wasm one
# (build_python.sh), pointed at the wasm sysconfigdata so meson's python module
# reports the wasm include dir / config.
NATIVE_PY="$BLD/python-native/python"
[ -x "$NATIVE_PY" ] || { echo "run scripts/build_python.sh first" >&2; exit 1; }
VENV="$BLD/numpy-venv"
if [ ! -x "$VENV/bin/cython" ]; then
  log "creating build venv (cython, ninja)"
  rm -rf "$VENV"
  "$NATIVE_PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q "cython==3.1.4" "ninja" "packaging"
fi
export PATH="$VENV/bin:$PATH"

PYLIB="$SYSROOT/lib/python3.13"
cat > "$BLD/numpy-host-python.sh" <<EOF
#!/bin/sh
export _PYTHON_SYSCONFIGDATA_NAME=_sysconfigdata__emscripten_wasm32-emscripten
export PYTHONPATH="$PYLIB\${PYTHONPATH:+:\$PYTHONPATH}"
exec "$VENV/bin/python" "\$@"
EOF
chmod +x "$BLD/numpy-host-python.sh"

B="$BLD/numpy"; rm -rf "$B"; mkdir -p "$B"
cat > "$B/cross.ini" <<EOF
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
strip = 'true'
python = '$BLD/numpy-host-python.sh'
cython = '$VENV/bin/cython'

[built-in options]
c_args = [$(printf "'%s'," $WASM_CFLAGS) '-I$SYSROOT/include/python3.13']
cpp_args = [$(printf "'%s'," $WASM_CXXFLAGS) '-I$SYSROOT/include/python3.13']
c_link_args = ['-pthread']
cpp_link_args = ['-pthread']

[properties]
longdouble_format = 'IEEE_QUAD_LE'
needs_exe_wrapper = true
skip_sanity_check = true

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
EOF

log "configuring numpy $NPV"
( cd "$NPSRC"
  "$VENV/bin/python" vendored-meson/meson/meson.py setup "$B/build" \
    --cross-file "$B/cross.ini" \
    --prefix=/numpy-install --buildtype=release \
    -Ddefault_library=static \
    -Dblas=none -Dlapack=none -Dallow-noblas=true \
    -Ddisable-optimization=true -Dcpu-baseline=none -Dcpu-dispatch=none \
    -Ddisable-threading=true \
    -Dpython.install_env=auto )
log "building numpy"
# Extension-module "links" are irrelevant (we take the objects); let them fail.
ninja -C "$B/build" -j"$NPROC" -k 0 || true

# --- one static namespace -----------------------------------------------------
# As separate .so files each module had private globals; linked together, two
# kinds collide:
#  * mtrand compiles its OWN distributions.c with NP_RANDOM_LEGACY=1 (`long`
#    ints → i32 on wasm32), clashing with npyrandom's int64 random_* functions
#    under the same names. Recompile mtrand's objects with a forced include
#    that renames every global they define to mtrand_*.
#  * _umath_linalg and lapack_lite both compile the bundled lapack_lite f2c
#    sources with identical flags: keep lapack_lite's copy only (SKIP below).
MT="numpy/random/mtrand.cpython-313-wasm32-emscripten.so.p"
emnm --defined-only --extern-only "$B/build/$MT"/src_*.o \
  | awk '$2 ~ /[TDBR]/ && $3 != "PyInit_mtrand" {print "#define " $3 " mtrand_" $3}' \
  | sort -u > "$B/mtrand_rename.h"
python3 - "$B/build" "$MT" "$B/mtrand_rename.h" <<'PYEOF'
import json, shlex, subprocess, sys
bdir, mt, hdr = sys.argv[1:]
for c in json.load(open(bdir + "/compile_commands.json")):
    if c["output"].startswith(mt + "/") and c["output"].endswith(".o"):
        args = shlex.split(c["command"])
        subprocess.check_call(args[:1] + ["-include", hdr] + args[1:], cwd=c["directory"])
PYEOF
log "renamed $(wc -l < "$B/mtrand_rename.h") mtrand globals"

# --- libnumpy.a + numpy_inittab.o ---------------------------------------------
# Every object of the shipped extension modules and the static helper libs they
# link (npymath, npyrandom, highway, the *.dispatch.h_baseline loop libs, ...),
# minus numpy's test-only modules. Prefixed by target so same-basename objects
# from different targets don't replace each other in the archive. (lapack_lite's
# f2c sources are compiled into two modules; the archive only pulls one copy.)
NPOBJ="$B/objs"; rm -rf "$NPOBJ"; mkdir -p "$NPOBJ"
SKIP_RE='_(multiarray|umath|rational|struct_ufunc|operand_flag)_tests|_simd'
find "$B/build" -path '*.p/*' -name '*.o' | grep -Ev "/($SKIP_RE)[^/]*\.p/" \
  | grep -v '/_umath_linalg[^/]*\.p/lapack_lite_' | while read -r o; do
  t=$(basename "$(echo "$o" | sed 's|\.p/.*||')")
  cp "$o" "$NPOBJ/${t%%.*}__$(echo "${o#*.p/}" | tr '/' '_')"
done
rm -f "$SYSROOT/lib/libnumpy.a"
emar qc "$SYSROOT/lib/libnumpy.a" "$NPOBJ"/*.o
emranlib "$SYSROOT/lib/libnumpy.a"
log "libnumpy.a: $(ls "$NPOBJ" | wc -l) objects"

# Extension modules -> dotted builtin names (from the install layout).
MODS=$(cd "$B/build" && find numpy -name '*.cpython-313-wasm32-emscripten.so' \
  | grep -Ev "/($SKIP_RE)[^/]*\.so$" | sed 's|\.cpython-313-wasm32-emscripten\.so$||' | tr '/' '.' | sort)
{
  echo '/* Generated by scripts/build_numpy.sh: numpy extension modules as builtins. */'
  echo '#include <Python.h>'
  for m in $MODS; do echo "PyMODINIT_FUNC PyInit_${m##*.}(void);"; done
  echo 'static struct _inittab numpy_inittab[] = {'
  for m in $MODS; do echo "  {\"$m\", PyInit_${m##*.}},"; done
  echo '  {NULL, NULL}};'
  echo '/* Runs from __wasm_call_ctors, i.e. before Blender calls Py_Initialize. */'
  echo '__attribute__((constructor)) static void numpy_register_builtins(void) {'
  echo '  PyImport_ExtendInittab(numpy_inittab);'
  echo '}'
} > "$B/numpy_inittab.c"
emcc $WASM_CFLAGS -I"$SYSROOT/include/python3.13" -c "$B/numpy_inittab.c" -o "$SYSROOT/lib/numpy_inittab.o"
log "builtin modules: $(echo $MODS)"

# --- pure-Python package -------------------------------------------------------
rm -rf "$B/dest"
"$VENV/bin/python" "$NPSRC/vendored-meson/meson/meson.py" install -C "$B/build" \
  --destdir "$B/dest" --no-rebuild --skip-subprojects >/dev/null
PKG=$(find "$B/dest" -type d -name numpy -path '*site-packages/numpy' | head -1)
DST="$PYLIB/site-packages/numpy"
rm -rf "$DST"; cp -r "$PKG" "$DST"
( cd "$DST" && find . \( -name '*.so' -o -name '*.a' -o -name '*.pyi' -o -name '*.pxd' \) -delete \
    && find . -type d \( -name tests -o -name __pycache__ \) -prune -exec rm -rf {} + \
    && rm -rf _core/include _core/lib random/lib _pyinstaller )
log "installed numpy python package into $DST ($(du -sh "$DST" | cut -f1))"
