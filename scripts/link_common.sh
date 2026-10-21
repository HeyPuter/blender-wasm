#!/usr/bin/env bash
# Helpers shared by the scripts/link_blender_*.sh relink scripts. Source it.
#
# Every relink reuses CMake's exact object/library link line for the `blender`
# target (so it never drifts from the build), retargets the output, and appends
# flavour-specific emscripten settings.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# cmake_link_cmd <out.js>
# Prints CMake's em++ link command for `blender`, writing to <out.js>.
# The ninja rule is  `: && <em++ link …> && cd <dir> && cmake -E echo Run:…`;
# keep only the em++ segment.
cmake_link_cmd() {
  local out="$1" raw cmd
  [ -f "$BLENDER_BUILD/build.ninja" ] || die "no configured Blender build at $BLENDER_BUILD"
  raw=$(ninja -C "$BLENDER_BUILD" -t commands blender | grep -- "-o bin/blender.js" | tail -1)
  [ -n "$raw" ] || die "could not find the blender link line in $BLENDER_BUILD"
  cmd=${raw#*&& }
  cmd=${cmd%% && cd *}
  cmd=${cmd/-o bin\/blender.js/-o $out}
  # CMake's node CLI defaults; every flavour supplies its own filesystem.
  cmd=${cmd//-sNODERAWFS=1/}
  printf '%s' "$cmd"
}

# Libraries every Blender relink adds to CMake's line. freetype is built with
# woff2 and decompresses Blender's .woff2 UI fonts through brotli, which the
# CMake link line omits ("missing function: BrotliDecoderDecompress" at the
# first font load).
EXTRA_LINK_LIBS="$SYSROOT/lib/libbrotlidec.a $SYSROOT/lib/libbrotlicommon.a"

# stage_cycles_addon <stage-dir>
# Cycles' Python add-on lives with its sources, not in scripts/ (CMake installs
# it); without it the engine is compiled in but cannot be selected. Staged only
# when the build tree was configured WITH_CYCLES.
stage_cycles_addon() {
  local dst="$1/$BLENDER_VERSION_DIR/scripts/addons_core/cycles"
  grep -q "^WITH_CYCLES:BOOL=ON" "$BLENDER_BUILD/CMakeCache.txt" 2>/dev/null || return 0
  cp -r "$BLENDER_SRC/intern/cycles/blender/addon" "$dst"
  find "$dst" -name '__pycache__' -type d -prune -exec rm -rf {} +
}

# stage_assets <stage-dir> <python-subdir>
# Copies Blender's runtime data (scripts + datafiles) to <stage>/<version>/ and
# the trimmed CPython stdlib to <stage>/<python-subdir>/.
stage_assets() {
  local stage="$1" pydir="$2" v="$BLENDER_VERSION_DIR"
  log "staging assets -> $stage"
  rm -rf "$stage"; mkdir -p "$stage/$v" "$(dirname "$stage/$pydir")"
  cp -r "$BLENDER_SRC/scripts"           "$stage/$v/scripts"
  cp -r "$BLENDER_SRC/release/datafiles" "$stage/$v/datafiles"
  cp -r "$SYSROOT/lib/python3.13"        "$stage/$pydir"
  # Tests, caches and dev-only modules. config-3.13-*/ holds a 41 MB
  # libpython3.13.a never read at runtime; ensurepip is a pip wheel (no pip on
  # wasm). splash_template.xcf is a GIMP source shipped by accident upstream.
  ( cd "$stage/$pydir" && rm -rf test tests idlelib lib2to3 turtledemo tkinter \
      config-3.13-wasm32-emscripten ensurepip \
      && find . -name '__pycache__' -type d -prune -exec rm -rf {} + )
  rm -f "$stage/$v/datafiles/splash_template.xcf"
}

# stage_cycles_addon <stage-dir>
# Cycles is registered as a render engine by a Python addon, not by the C
# library. CMake's *install* step copies it into scripts/, which staging skips,
# so a Cycles-enabled build would otherwise only offer EEVEE.
stage_cycles_addon() {
  local stage="$1" addon="$BLENDER_SRC/intern/cycles/blender/addon"
  [ -d "$addon" ] || return 0
  mkdir -p "$stage/$BLENDER_VERSION_DIR/scripts/addons_core/cycles"
  cp -r "$addon/." "$stage/$BLENDER_VERSION_DIR/scripts/addons_core/cycles/"
  log "staged cycles addon"
}

# stage_numpy <python-stage-dir>
# io_scene_gltf2 imports numpy at module scope; scripts/build_numpy_side.sh
# cross-builds it as emscripten SIDE_MODULEs loaded through CPython's dlopen.
stage_numpy() {
  local pystage="$1" whl
  whl=$(ls "$NUMPY_BUILD/dist/"*.whl 2>/dev/null | head -1 || true)
  if [ -z "$whl" ]; then
    log "WARNING: no numpy wheel in $NUMPY_BUILD/dist — glTF import/export will fail"
    return 0
  fi
  log "staging numpy from $(basename "$whl")"
  rm -rf "$pystage/site-packages/numpy"
  mkdir -p "$pystage/site-packages"
  ( cd "$pystage/site-packages" && unzip -o -q "$whl" -x '*.dist-info/RECORD' )
}

# trim_headless_assets <stage-dir> <python-subdir>
# What a headless Blender never reads, out of the data package. Boot copies the
# whole package into the in-memory FS, so every MB is boot time (and it is the
# phase that suffers most under memory pressure). UI-only datafiles go, numpy's
# test suites go, and the fonts shrink to Blender's two defaults (the Noto
# fallbacks for other scripts and emoji are 13 MB; BLENDER_WASM_ALL_FONTS=1
# keeps them, e.g. for text objects in CJK).
trim_headless_assets() {
  local stage="$1" pydir="$2" data="$1/$BLENDER_VERSION_DIR/datafiles"
  rm -rf "$data/icons" "$data/icons_svg" "$data/icons_blend" "$data/studiolights" "$data/cursors"
  rm -f "$data"/splash*.png "$data"/preview*.blend
  if [ "${BLENDER_WASM_ALL_FONTS:-0}" != 1 ]; then
    find "$data/fonts" -type f ! -name 'Inter.woff2' ! -name 'DejaVuSansMono.woff2' -delete
  fi
  find "$stage/$pydir/site-packages/numpy" -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$stage/$pydir/pydoc_data"
  log "trimmed headless assets -> $(du -sh "$stage" | cut -f1)"
}

# host_python313
# A host interpreter of the target's version (3.13), so its bytecode matches:
# python3 when it is 3.13, else the native build-python build_python.sh made.
host_python313() {
  local candidate
  for candidate in "${PYTHON:-}" python3.13 "$DEPS/build/python-native/python.exe" "$DEPS/build/python-native/python"; do
    [ -n "$candidate" ] || continue
    if "$candidate" -c "import sys; sys.exit(sys.version_info[:2] != (3, 13))" 2>/dev/null; then
      printf '%s' "$candidate"; return 0
    fi
  done
  return 1
}

# precompile_python <dir>...
# Every boot otherwise compiles Blender's scripts and the stdlib from source
# (wasm has no __pycache__ on a fresh preloaded FS). unchecked-hash .pyc are
# used regardless of the source's mtime, which the preloaded FS does not keep.
precompile_python() {
  local py
  py=$(host_python313) || { log "WARNING: no Python 3.13 host interpreter; shipping without .pyc"; return 0; }
  log "precompiling Python ($(basename "$py"))"
  "$py" -m compileall -q -j 0 --invalidation-mode unchecked-hash "$@" >/dev/null || \
    log "WARNING: some files did not compile (left as source)"
}

# undef_stub_object
# Compiles scripts/undef_symbols.txt into no-op definitions and prints the
# object path. See scripts/gen_undef_stubs.py for why they must exist.
UNDEF_TXT="${UNDEF_TXT:-$ROOT/scripts/undef_symbols.txt}"
undef_stub_object() {
  local dir="$BLENDER_BUILD/blender-wasm-stubs"
  mkdir -p "$dir"
  python3 "$ROOT/scripts/gen_undef_stubs.py" "$UNDEF_TXT" "$dir/undef_stubs.c" >&2
  "$EM_BIN/emcc" -fPIC -O1 -c "$dir/undef_stubs.c" -o "$dir/undef_stubs.o"
  printf '%s' "$dir/undef_stubs.o"
}

# unresolved_symbols <blender.js>
# Prints symbols the MAIN_MODULE link left unresolved and the stub list lacks.
# A MAIN_MODULE link does not report undefined symbols (they may come from a
# side module at runtime); instead the glue gets a JS stub per symbol, marked
# `_<name>.stub = true`, that aborts if it is ever called.
unresolved_symbols() {
  grep -oE '_[A-Za-z0-9_$]+\.stub = true' "$1" 2>/dev/null \
    | sed -E 's/^_//; s/\.stub = true$//' | LC_ALL=C sort -u \
    | comm -23 - <(grep -v '^#' "$UNDEF_TXT" | sed '/^$/d' | LC_ALL=C sort -u)
}
