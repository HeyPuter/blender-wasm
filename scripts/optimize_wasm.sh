#!/usr/bin/env bash
# Post-link optimisation of a linked blender.wasm with Binaryen's wasm-opt.
#
#   bash scripts/optimize_wasm.sh <dir-or-wasm> [more...]
#
# The relinks run at -O1 because a full -O2/-O3 emcc link of a ~140 MB module is
# slow and memory-hungry to iterate on. This pass runs wasm-opt once on the
# finished module instead. It only rewrites function bodies: imports, exports,
# the table and the dylink.0 section are preserved, so the emscripten glue
# (blender.js) keeps working unchanged and the headless MAIN_MODULE can still
# dlopen numpy's side modules.
#
# Knobs:
#   WASM_OPT_LEVEL     -O2 (default), -O3, -Os, -Oz, -O1
#   WASM_OPT_STRIP     1 strips the name section and producers (smaller, but
#                      stack traces lose function names). Default 0.
#   WASM_OPT_FEATURES  the feature flags handed to wasm-opt; the defaults are the
#                      ones this build compiles with (pthreads, SIMD, bulk
#                      memory, ...). emcc strips the target_features section, so
#                      they cannot be detected from the module.
#   BINARYEN_CORES     threads wasm-opt may use (default: all).
#
# The original is kept as blender.unopt.wasm next to the output until the
# optimised module validates; pass KEEP_UNOPT=0 to delete it afterwards.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[ $# -ge 1 ] || die "usage: optimize_wasm.sh <dir-or-wasm> [more...]"

WASM_OPT="${WASM_OPT:-}"
if [ -z "$WASM_OPT" ]; then
  if [ -x "$BINARYEN_BIN/wasm-opt" ]; then WASM_OPT="$BINARYEN_BIN/wasm-opt"
  else WASM_OPT="$(command -v wasm-opt || true)"; fi
fi
[ -x "$WASM_OPT" ] || die "wasm-opt not found (install the emsdk: ./build.sh toolchain)"

LEVEL="${WASM_OPT_LEVEL:--O2}"
FEATURES="${WASM_OPT_FEATURES:---enable-threads --enable-simd --enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-multivalue}"
STRIP_FLAGS=""
[ "${WASM_OPT_STRIP:-0}" = 1 ] && STRIP_FLAGS="--strip-debug --strip-producers"
KEEP_UNOPT="${KEEP_UNOPT:-1}"

size() { wc -c < "$1" | tr -d ' '; }
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }

optimize_one() {
  local wasm="$1" dir unopt before after start
  dir="$(dirname "$wasm")"
  unopt="$dir/$(basename "$wasm" .wasm).unopt.wasm"
  # Re-running must start from the linker's output, not optimise twice: a wasm
  # newer than the saved copy is fresh linker output; otherwise reuse the copy.
  if [ ! -f "$unopt" ] || [ "$wasm" -nt "$unopt" ]; then cp -p "$wasm" "$unopt"; fi
  before=$(size "$unopt")
  log "$wasm: wasm-opt $LEVEL ${STRIP_FLAGS:+(stripped) }from $(mb "$before")"
  start=$(date +%s)
  # shellcheck disable=SC2086
  "$WASM_OPT" $LEVEL $FEATURES $STRIP_FLAGS "$unopt" -o "$wasm.tmp"
  # wasm-opt validates whatever it reads, so reading the output back with no
  # passes is the check that a bad module never replaces a good one.
  # shellcheck disable=SC2086
  "$WASM_OPT" -q $FEATURES "$wasm.tmp"
  mv "$wasm.tmp" "$wasm"
  touch -r "$wasm" "$unopt"
  after=$(size "$wasm")
  log "$wasm: $(mb "$before") -> $(mb "$after") in $(( $(date +%s) - start ))s"
  [ "$KEEP_UNOPT" = 1 ] || rm -f "$unopt"
}

for target in "$@"; do
  if [ -d "$target" ]; then
    [ -f "$target/blender.wasm" ] || die "no blender.wasm in $target"
    optimize_one "$target/blender.wasm"
  else
    optimize_one "$target"
  fi
done
