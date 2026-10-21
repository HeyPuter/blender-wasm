#!/usr/bin/env bash
# Cross-compile numpy for wasm32-emscripten / CPython 3.13 → side modules.
#
# Why this exists: Blender's glTF addon (io_scene_gltf2) imports numpy at module
# scope, so without it `bpy.ops.import_scene.gltf` / `export_scene.gltf` cannot
# run. No usable prebuilt wheel exists: Pyodide's is cp312 / emscripten 3.1.58,
# we are cp313 / emscripten 6.0.1.
#
# The extensions are built as SIDE_MODULEs (see cmake/emscripten-cross.ini.in)
# so CPython's dlopen can load them. That requires the Blender module to be
# linked with -sMAIN_MODULE, which in turn requires the whole sysroot to be
# -fPIC (dep_common.sh's default WASM_CFLAGS).
#
# Self-bootstrapping: downloads the numpy sdist and creates the host build venv
# (meson-python + Cython) on first run. Needs the CPython sysroot (dep-python).
#
#   bash scripts/build_numpy_side.sh   (headless builds; the GUI build links
#   numpy statically via scripts/build_numpy.sh instead)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

NUMPY_VERSION="${NUMPY_VERSION:-2.2.6}"
WORK="$NUMPY_BUILD"
VENV="$ROOT/.venv-numpy"
SRC="$WORK/numpy-$NUMPY_VERSION"
OUT="${OUT:-$WORK/dist}"
CROSS="$WORK/emscripten-cross.ini"

[ -f "$SYSROOT/lib/python3.13/_sysconfigdata__emscripten_wasm32-emscripten.py" ] \
  || die "CPython sysroot missing — build it first (./build.sh deps)"

mkdir -p "$WORK" "$OUT"

# --- numpy sdist -------------------------------------------------------------
if [ ! -d "$SRC" ]; then
  tarball="$WORK/numpy-$NUMPY_VERSION.tar.gz"
  if [ ! -f "$tarball" ]; then
    log "downloading numpy $NUMPY_VERSION sdist"
    curl -fL --retry 3 -o "$tarball.tmp" \
      "https://files.pythonhosted.org/packages/source/n/numpy/numpy-$NUMPY_VERSION.tar.gz"
    mv "$tarball.tmp" "$tarball"
  fi
  tar -C "$WORK" -xzf "$tarball"
fi

# --- host build venv -----------------------------------------------------------
# The venv's interpreter must be the target's version (3.13): the cross build
# puts the target stdlib on PYTHONPATH, and a newer host interpreter importing
# it breaks (pip itself dies inside its vendored rich). Use the host python3
# when it is 3.13, else the native build-python that build_python.sh made.
TARGET_PY=3.13
venv_python() {
  if "$PYTHON" -c "import sys; sys.exit(sys.version_info[:2] != (3, 13))" 2>/dev/null; then
    echo "$PYTHON"; return
  fi
  local native="$DEPS/build/python-native"
  for candidate in "$native/python.exe" "$native/python"; do
    [ -f "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  die "need a Python $TARGET_PY host interpreter: PYTHON=python3.13, or build CPython first (./build.sh deps)"
}
if [ -x "$VENV/bin/python" ] \
    && ! "$VENV/bin/python" -c "import sys; sys.exit(sys.version_info[:2] != (3, 13))" 2>/dev/null; then
  log "replacing $VENV: it is not Python $TARGET_PY"
  rm -rf "$VENV"
fi
if [ ! -x "$VENV/bin/python" ]; then
  log "creating build venv $VENV with $(venv_python)"
  "$(venv_python)" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet "meson-python>=0.15" meson ninja "Cython>=3.0.6" wheel
fi

# --- meson cross file (rendered from the template for this checkout) --------
# The ABI flags as a meson list: '-pthread', '-fexceptions' (or the THREADS=0 set).
ABI_LIST=$(printf "'%s', " $ABI_FLAGS); ABI_LIST="${ABI_LIST%, }"
sed -e "s|@EM_BIN@|$EM_BIN|g" -e "s|@ABI_FLAGS@|$ABI_LIST|g" "$ROOT/cmake/emscripten-cross.ini.in" > "$CROSS"

# The venv's bin comes first so meson finds `cython` — it treats Cython as a
# compiler for the host machine and looks it up on PATH, not in the cross file.
export PATH="$VENV/bin:$PATH"

# Point every Python introspection at the TARGET interpreter, not the host one.
# Without this meson-python configures against the host CPython and emits a
# wheel with the wrong ABI tag and the wrong headers.
export _PYTHON_SYSCONFIGDATA_NAME="_sysconfigdata__emscripten_wasm32-emscripten"
export PYTHONPATH="$SYSROOT/lib/python3.13"
export PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"

cd "$SRC"

log "cross-building numpy $NUMPY_VERSION for wasm32-emscripten (cp313)"
# allow-noblas: no BLAS/LAPACK in the wasm sysroot, and the glTF addon only uses
# array/dtype/reshape operations, none of which need an accelerated backend.
# disable-optimization: numpy's SIMD dispatch probes by running binaries, which
# is impossible when cross-compiling to wasm.
"$VENV/bin/python" -m pip wheel . \
  --no-build-isolation \
  --no-deps \
  -w "$OUT" \
  -Csetup-args="--cross-file=$CROSS" \
  -Csetup-args="-Dallow-noblas=true" \
  -Csetup-args="-Ddisable-optimization=true" \
  -Cbuild-dir="$WORK/meson"

ls -la "$OUT"/*.whl 2>/dev/null || die "no wheel produced"
