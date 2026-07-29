#!/usr/bin/env bash
# Brotli 1.0.9 → wasm-sysroot. Needed by FreeType (woff2). Brotli's CMake has no
# usable install target, so configure+build the static libs and stage them by
# hand (+ pkg-config .pc files so FreeType's BrotliDec detection finds them).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/google/brotli/archive/refs/tags/v1.0.9.tar.gz" \
  "brotli-v1.0.9.tar.gz" "brotli-1.0.9")

b="$BLD/brotli"; rm -rf "$b"
emcmake cmake -S "$src" -B "$b" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DBUILD_SHARED_LIBS=OFF -DBROTLI_DISABLE_TESTS=ON \
  -DCMAKE_C_FLAGS="$WASM_CFLAGS" -DCMAKE_CXX_FLAGS="$WASM_CXXFLAGS"
ninja -C "$b" -j"$NPROC" brotlicommon-static brotlidec-static brotlienc-static

# Stage headers + libs under both the -static and the plain names downstream wants.
mkdir -p "$SYSROOT/include" "$SYSROOT/lib/pkgconfig"
cp -r "$src/c/include/brotli" "$SYSROOT/include/"
for n in common dec enc; do
  cp -f "$b/libbrotli${n}-static.a" "$SYSROOT/lib/libbrotli${n}.a"
  cat > "$SYSROOT/lib/pkgconfig/libbrotli${n}.pc" <<EOF
prefix=$SYSROOT
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: libbrotli${n}
Description: Brotli ${n}
Version: 1.0.9
Libs: -L\${libdir} -lbrotli${n}$([ "$n" = common ] || echo " -lbrotlicommon")
Cflags: -I\${includedir}
EOF
done
log "installed brotli into $SYSROOT"
