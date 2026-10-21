#!/usr/bin/env bash
# One entry point for every build of Blender → WebAssembly.
#
#   ./build.sh doctor     check host prerequisites
#   ./build.sh node       headless runtime for Node     -> dist/blender-wasm-node/
#   ./build.sh browser    headless runtime for workers  -> dist/blender-wasm-browser/
#                         (pthreads: needs a cross-origin isolated page)
#   ./build.sh browser-st single-threaded headless runtime (no pthreads, JSPI)
#                         for any page                   -> dist/blender-wasm-browser-st/
#   ./build.sh web        full GUI (WebGPU) demo site   -> demo/dist, dist/blender-web-*.tar.gz
#
# Each flavour runs every step it needs and skips the ones already done, so the
# same command takes a fresh clone to a packaged artifact (hours: the dependency
# stack and Blender itself are compiled from source) and re-runs in minutes.
#
# Steps, also runnable alone:
#   toolchain   in-repo emsdk (pinned)
#   source      Blender fork checkout + LFS datafiles
#   deps        dependency stack + CPython into wasm-sysroot/
#   numpy       numpy side modules (headless flavours)
#   configure   <headless|gui>   CMake configure of the Blender build dir
#   compile     ninja: every Blender object and library
#   link        <node|browser|web>
#   optimize    <dir-or-wasm>    wasm-opt pass (scripts/optimize_wasm.sh)
#   compress    <file...>        .zst / .br (scripts/compress.sh)
#   package     <node|browser|web>
#
# Knobs (environment):
#   OPTIMIZE=0          skip wasm-opt          WASM_OPT_LEVEL=-O2|-O3|-Os|-Oz
#   WASM_OPT_STRIP=1    drop function names    LINK_OPT=-O1 (emcc link level)
#   ZSTD_LEVEL=21       BROTLI_QUALITY=11      COMPRESS_BROTLI=0
#   FORCE=1             redo steps that are already stamped done
#   BLENDER_BUILD=dir   Blender build tree (default build-blender). The headless
#                       and GUI configures differ, so sharing one tree means a
#                       full recompile when switching; give each its own dir if
#                       disk allows, e.g. BLENDER_BUILD=$PWD/build-headless.
#   BLENDER_URL / BLENDER_REF   which Blender fork + commit to build (cloned
#                       into blender/; delete it or FORCE=1 to switch)
#   NPROC               parallel compile jobs per build
#   DEP_JOBS            dependencies built at once within a wave (default: all;
#                       DEP_JOBS=2 NPROC=6 keeps a laptop usable)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# browser-st is the single-threaded ABI end to end (scripts/env.sh).
for arg in "$@"; do [ "$arg" = browser-st ] && export THREADS=0; done
source scripts/env.sh

OPTIMIZE="${OPTIMIZE:-1}"
export WASM_OPT_LEVEL="${WASM_OPT_LEVEL:--O2}"
FORCE="${FORCE:-0}"
STAMPS="$ROOT/.stamps$ST"
mkdir -p "$STAMPS"

# make's `deps` is phony and dep-python matches the dep-% pattern rule, so plain
# `make configure-*` would rebuild the whole dependency stack every time. These
# say "already handled by build.sh".
MAKE_SKIP=(-o toolchain -o deps -o dep-python -o blender -o blender-assets)

# Every make call sees the same emsdk and build tree as the scripts.
mk() {
  local extra=""
  [ "$THREADS" = 0 ] && extra="-DWITH_TBB=OFF -DWITH_CYCLES=OFF"
  make EMSDK="$EMSDK" BLENDER_BUILD="$BLENDER_BUILD" SYSROOT="$SYSROOT" DEPS="$DEPS" \
    ABI_FLAGS="$ABI_FLAGS" HEADLESS_EXTRA="$extra" "$@"
}

stamped() { [ "$FORCE" != 1 ] && [ -f "$STAMPS/$1" ]; }
stamp() { date -u +%FT%TZ > "$STAMPS/$1"; }
step() { echo; echo "==== $* ===="; }

# --- doctor --------------------------------------------------------------------
doctor() {
  local missing=0 tool
  need() {
    if command -v "$1" >/dev/null; then printf '  ok       %-10s %s\n' "$1" "$(command -v "$1")"
    else printf '  MISSING  %-10s %s\n' "$1" "$2"; missing=1; fi
  }
  want() {
    if command -v "$1" >/dev/null; then printf '  ok       %-10s %s\n' "$1" "$(command -v "$1")"
    else printf '  optional %-10s %s\n' "$1" "$2"; fi
  }
  echo "host: $HOST_OS, $NPROC jobs, ROOT=$ROOT"
  for tool in git curl tar unzip patch make cmake ninja pkg-config; do need "$tool" "build tool"; done
  need git-lfs "Blender datafiles are LFS objects"
  need python3 "host Python 3.10+ (numpy build venv, codegen helpers)"
  need node "Node 22.15+ (emscripten, the API, the demo build)"
  need npm "demo build"
  need zstd "artifact compression"
  local probe; probe="$(mktemp -d)"
  printf 'int main(void) { return 0; }\n' > "$probe/p.c"
  if cc "$probe/p.c" -o "$probe/p" 2>/dev/null; then
    echo "  ok       host cc    links${DEVELOPER_DIR:+ (DEVELOPER_DIR=$DEVELOPER_DIR)}"
  else
    echo "  BROKEN   host cc    cannot link a trivial program (native build-python, shader_tool)"; missing=1
  fi
  rm -rf "$probe"
  want brotli ".br artifacts for HTTP serving"
  # The dep builds rely on GNU behaviour (install -D, sed -i, stat -c, find
  # -printf). On macOS env.sh puts Homebrew's GNU tools first; check that it did.
  for tool in make sed find install stat; do
    if "$tool" --version 2>/dev/null | head -1 | grep -q GNU; then
      printf '  ok       %-10s GNU (%s)\n' "$tool" "$(command -v "$tool")"
    else
      printf '  NOT GNU  %-10s %s — brew install make gnu-sed findutils coreutils\n' "$tool" "$(command -v "$tool")"
      missing=1
    fi
  done
  if command -v node >/dev/null; then
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=15)?0:1)' \
      || { echo "  OLD      node $(node --version) — need 22.15+"; missing=1; }
  fi
  if [ -x "$EM_BIN/emcc" ]; then echo "  ok       emsdk      $("$EM_BIN/emcc" --version | head -1)"
  else echo "  pending  emsdk      ./build.sh toolchain installs $EMSDK_VERSION into $EMSDK"; fi
  local free_gb
  free_gb=$(df -Pk "$ROOT" | awk 'NR==2 { printf "%d", $4 / 1048576 }')
  echo "  disk     ${free_gb} GB free (a full build wants ~40 GB)"
  [ "$missing" = 0 ] || die "install the missing tools above"
}

# --- steps -----------------------------------------------------------------------
toolchain() {
  [ -x "$EM_BIN/emcc" ] && [ "$FORCE" != 1 ] && return 0
  step toolchain; mk toolchain
}

source_tree() {
  stamped source && [ -d "$BLENDER_SRC/.git" ] && return 0
  step "source ${BLENDER_URL:-default fork} @ ${BLENDER_REF:-pinned}"
  mk blender blender-assets
  stamp source
}

deps() {
  toolchain
  if ! stamped deps; then step deps; bash scripts/build_all_deps.sh; stamp deps; fi
  if ! stamped python; then step "CPython 3.13"; bash scripts/build_python.sh; stamp python; fi
}

numpy() {
  deps
  if [ "$FORCE" != 1 ] && ls "$NUMPY_BUILD"/dist/*.whl >/dev/null 2>&1; then return 0; fi
  step numpy; bash scripts/build_numpy_side.sh
}

# patches/blender/: this repository's changes to the Blender fork, each guarded
# so it only acts in the build it is for (BLI_THREADS_INLINE: the
# single-threaded one). Applied once; a patch already in the tree is skipped.
blender_patches() {
  local p
  for p in "$ROOT"/patches/blender/*.patch; do
    [ -f "$p" ] || continue
    if git -C "$BLENDER_SRC" apply --reverse --check "$p" 2>/dev/null; then continue; fi
    log "applying $(basename "$p")"
    git -C "$BLENDER_SRC" apply "$p" || die "$(basename "$p") does not apply to $BLENDER_SRC"
  done
}

configure() {
  local kind="$1" marker target
  # The cache entry that tells the two configures apart.
  case "$kind" in
    headless) marker='^WITH_HEADLESS:BOOL=ON';        target=configure-blender-headless ;;
    gui)      marker='^WITH_WEBGPU_BACKEND:BOOL=ON';  target=configure-blender ;;
    *) die "configure headless|gui" ;;
  esac
  toolchain; source_tree; deps; blender_patches
  if [ "$FORCE" != 1 ] && grep -q "$marker" "$BLENDER_BUILD/CMakeCache.txt" 2>/dev/null; then
    return 0
  fi
  [ -f "$BLENDER_BUILD/CMakeCache.txt" ] && log "$BLENDER_BUILD was configured for the other flavour; reconfiguring (full recompile)"
  step "configure $kind -> $BLENDER_BUILD"
  mk "${MAKE_SKIP[@]}" "$target"
}

compile() {
  step "compile -> $BLENDER_BUILD"
  # CMake's own final link of bin/blender.js is expected to fail: the relink
  # scripts supply what it lacks (memory settings, stubs, WasmFS backends). So
  # build everything and accept a failure only when that link is all that is left.
  if ! ninja -C "$BLENDER_BUILD" -j"$NPROC" blender; then
    # Blender's buildinfo.h is a deliberately always-stale output, so ninja
    # lists it (and buildinfo.c.o) before the link every time.
    local left
    left=$(ninja -C "$BLENDER_BUILD" -n blender | grep -E '^\[[0-9]+/[0-9]+\]' || true)
    if printf '%s' "$left" | grep -q 'bin/blender.js' \
        && ! printf '%s\n' "$left" | grep -vE 'buildinfo|bin/blender\.js' | grep -q .; then
      log "objects and libraries complete; CMake's standalone link is skipped by design"
    else
      die "compile failed before the final link"
    fi
  fi
}

link() {
  local flavor="$1"
  step "link $flavor"
  case "$flavor" in
    node|browser|browser-st) TARGET="$flavor" bash scripts/link_blender_headless.sh ;;
    web) BLENDER_GPU=webgpu OPTIMIZE="$OPTIMIZE" bash scripts/link_blender_release.sh ;;
    *) die "link node|browser|browser-st|web" ;;
  esac
}

optimize() {
  [ "$OPTIMIZE" = 1 ] || { export WASM_OPT_LEVEL=none; return 0; }
  step "optimize $* ($WASM_OPT_LEVEL)"
  bash scripts/optimize_wasm.sh "$@"
}

flavor() {
  local flavor="$1"
  doctor
  case "$flavor" in
    node|browser|browser-st)
      numpy
      configure headless; compile
      link "$flavor"
      optimize "$ROOT/$flavor"
      step "package $flavor"; bash scripts/package.sh "$flavor"
      # The page-side brotli decoder the npm package ships with the runtime.
      if [ "$flavor" != node ]; then bash scripts/build_brotli_decoder.sh; fi ;;
    web)
      configure gui; compile
      [ "$OPTIMIZE" = 1 ] || export WASM_OPT_LEVEL=none
      link web
      step "package web"; bash scripts/package.sh web ;;
  esac
  echo; echo "==== done: $flavor ===="
  ls -la "$DIST"
}

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  doctor)    doctor ;;
  node|browser|browser-st|web) flavor "$cmd" ;;
  toolchain) toolchain ;;
  source)    source_tree ;;
  deps)      deps ;;
  numpy)     numpy ;;
  configure) configure "${1:?configure headless|gui}" ;;
  compile)   compile ;;
  link)      link "${1:?link node|browser|browser-st|web}" ;;
  optimize)  [ $# -ge 1 ] || die "optimize <dir-or-wasm>"; OPTIMIZE=1 optimize "$@" ;;
  compress)  bash scripts/compress.sh "$@" ;;
  package)   bash scripts/package.sh "${1:?package node|browser|browser-st|web}" ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
