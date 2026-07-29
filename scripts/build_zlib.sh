#!/usr/bin/env bash
# zlib 1.3.1 → wasm-sysroot. Smallest dep; validates the cross-compile pattern.
#
# NOTE: zlib's CMake defines both a SHARED `zlib` and a STATIC `zlibstatic`
# target, both with OUTPUT_NAME `z`. On wasm (no shared-lib support) CMake
# downgrades the SHARED target to STATIC, so BOTH emit `libz.a` and ninja aborts
# with "multiple rules generate libz.a". Avoid the whole mess by using zlib's
# own configure/make path with --static, which builds only the static archive.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"

src=$(fetch_extract \
  "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz" \
  "zlib-1.3.1.tar.gz" "zlib-1.3.1")

cd "$src"
make distclean >/dev/null 2>&1 || true
# zlib's configure honours CC/CFLAGS from the env; emconfigure points CC at emcc.
# Keep the same ABI flags as every other dep so the final link agrees.
export CFLAGS="$WASM_CFLAGS"
emconfigure ./configure --static --prefix="$SYSROOT"
emmake make -j"$NPROC" libz.a
emmake make install
# Drop any shared remnants so downstream links resolve to the static libz.a only.
rm -f "$SYSROOT"/lib/libz.so*
log "done"
