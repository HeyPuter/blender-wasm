#!/usr/bin/env bash
# Shared host environment for every build script. Source it; do not run it.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
#
# Everything here is derived from the checkout location and the host, never
# from a particular machine. Every value can be overridden from the caller's
# environment (ROOT, EMSDK, SYSROOT, PYTHON, NPROC, DEVELOPER_DIR, ...).

if [ -n "${BLENDER_WASM_ENV_LOADED:-}" ]; then return 0 2>/dev/null || exit 0; fi
BLENDER_WASM_ENV_LOADED=1

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The emsdk is pinned in-repo. A stale EMSDK exported by the user's shell must
# not redirect the build to some other toolchain, so only BLENDER_WASM_EMSDK
# overrides it.
EMSDK_VERSION="${EMSDK_VERSION:-6.0.1}"
EMSDK="${BLENDER_WASM_EMSDK:-$ROOT/emsdk}"
EM_BIN="$EMSDK/upstream/emscripten"
BINARYEN_BIN="$EMSDK/upstream/bin"

# THREADS=1 (default): the pthread ABI (-pthread, JS-based exceptions), for
# cross-origin isolated pages. THREADS=0: the single-threaded ABI (no
# -pthread; native wasm exceptions and setjmp/longjmp, which JSPI needs to
# suspend through C++ frames), for any page. Objects of the two ABIs cannot
# link together, so THREADS=0 has its own sysroot, deps, numpy and Blender
# build tree (the "-st" suffix); downloads are shared.
THREADS="${THREADS:-1}"
case "$THREADS" in
  1) ST="";    ABI_FLAGS="-pthread -fexceptions" ;;
  0) ST="-st"; ABI_FLAGS="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm" ;;
  *) echo "THREADS must be 1 or 0" >&2; exit 2 ;;
esac
SYSROOT="${SYSROOT:-$ROOT/wasm-sysroot$ST}"
DEPS="${DEPS:-$ROOT/deps$ST}"
DEPS_DOWNLOADS="${DEPS_DOWNLOADS:-$ROOT/deps/downloads}"
NUMPY_BUILD="${NUMPY_BUILD:-$ROOT/numpy-build$ST}"
# The Makefile clones Blender into blender/; scripts read it from here.
BLENDER_SRC="$ROOT/blender"
BLENDER_BUILD="${BLENDER_BUILD:-$ROOT/build-blender$ST}"
DIST="${DIST:-$ROOT/dist}"

HOST_OS="$(uname -s)"

if [ -z "${NPROC:-}" ]; then
  NPROC="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
fi

# --- macOS host ------------------------------------------------------------
# The dependency builds assume GNU make/sed/find/coreutils (stat -c, sed -i,
# find -printf ...). On macOS they come from Homebrew and are put ahead of the
# BSD tools. Linux hosts already have them.
GNU_PATH=""
if [ "$HOST_OS" = "Darwin" ]; then
  # A Mac can carry both an Apple-silicon (/opt/homebrew) and an Intel
  # (/usr/local) Homebrew, with the GNU tools split across them, so look for
  # each tool in every prefix rather than trusting `brew --prefix`.
  BREW_PREFIXES=""
  for candidate in ${BREW_PREFIX:-} /opt/homebrew /usr/local; do
    case " $BREW_PREFIXES " in *" $candidate "*) ;; *) [ -d "$candidate/bin" ] && BREW_PREFIXES="$BREW_PREFIXES $candidate" ;; esac
  done
  for tool in make gnu-sed findutils coreutils gnu-tar; do
    for prefix in $BREW_PREFIXES; do
      if [ -d "$prefix/opt/$tool/libexec/gnubin" ]; then
        GNU_PATH="$GNU_PATH:$prefix/opt/$tool/libexec/gnubin"
        break
      fi
    done
  done
  for prefix in $BREW_PREFIXES; do GNU_PATH="$GNU_PATH:$prefix/bin:$prefix/sbin"; done
  # BSD tar writes AppleDouble ._* files for extended attributes; packaged
  # runtime tarballs (assets.tar) must not carry them.
  export COPYFILE_DISABLE=1

  # The host compiler is needed for native tools (CPython's build-python,
  # shader_tool). A broken or mismatched Xcode selection can leave it unable to
  # link even though `xcrun` finds it (e.g. Xcode's linker against a newer
  # Command Line Tools SDK), so prove it by building a trivial program and fall
  # back to the Command Line Tools when that fails. Probed once per build: the
  # outcome is exported to child scripts.
  if [ -z "${DEVELOPER_DIR:-}" ] && [ -z "${BLENDER_WASM_CC_PROBED:-}" ]; then
    export BLENDER_WASM_CC_PROBED=1
    probe_dir="$(mktemp -d)"
    printf 'int main(void) { return 0; }\n' > "$probe_dir/probe.c"
    if ! cc "$probe_dir/probe.c" -o "$probe_dir/probe" >/dev/null 2>&1 \
        && [ -d /Library/Developer/CommandLineTools ] \
        && DEVELOPER_DIR=/Library/Developer/CommandLineTools cc "$probe_dir/probe.c" -o "$probe_dir/probe" >/dev/null 2>&1; then
      export DEVELOPER_DIR=/Library/Developer/CommandLineTools
    fi
    rm -rf "$probe_dir"
  fi
fi

export PATH="${GNU_PATH#:}${GNU_PATH:+:}$EM_BIN:$PATH"

export PYTHON="${PYTHON:-$(command -v python3)}"
export ROOT EMSDK EMSDK_VERSION EM_BIN BINARYEN_BIN SYSROOT DEPS DEPS_DOWNLOADS NUMPY_BUILD BLENDER_SRC BLENDER_BUILD DIST NPROC HOST_OS
export THREADS ST ABI_FLAGS

# Blender's data-file version directory (scripts/, datafiles/ live under it).
BLENDER_VERSION_DIR="${BLENDER_VERSION_DIR:-5.3}"
export BLENDER_VERSION_DIR

log() { echo ">> [$(basename "${0%.sh}")] $*" >&2; }
die() { echo "!! [$(basename "${0%.sh}")] $*" >&2; exit 1; }
