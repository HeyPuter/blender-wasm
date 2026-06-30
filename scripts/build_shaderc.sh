#!/usr/bin/env bash
# Build shaderc (GLSL→SPIR-V: glslang + SPIRV-Tools + shaderc) to WASM static
# libs in $SYSROOT. This is the GLSL→SPIR-V half of the WebGPU shader pipeline;
# Blender's Vulkan backend already uses shaderc the same way, so the WebGPU
# backend can reuse that GLSL-to-SPIR-V flow (then feed SPIR-V to WebGPU, or to
# Tint for WGSL).
source "$(dirname "$0")/dep_common.sh"

SHADERC_REF="${SHADERC_REF:-v2024.4}"

cd "$SRC"
if [ ! -d "$SRC/shaderc" ]; then
  log "cloning shaderc $SHADERC_REF"
  git clone --depth 1 -b "$SHADERC_REF" https://github.com/google/shaderc.git "$SRC/shaderc"
fi
cd "$SRC/shaderc"

# Pull pinned glslang / SPIRV-Tools / SPIRV-Headers into third_party/.
if [ ! -d "$SRC/shaderc/third_party/glslang" ]; then
  log "git-sync-deps (glslang, SPIRV-Tools, SPIRV-Headers)"
  python3 utils/git-sync-deps
fi

b="$BLD/shaderc"
rm -rf "$b"
log "configuring (emcmake)"
emcmake cmake -S "$SRC/shaderc" -B "$b" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DCMAKE_PREFIX_PATH="$SYSROOT" \
  -DCMAKE_C_FLAGS="$WASM_CFLAGS" \
  -DCMAKE_CXX_FLAGS="$WASM_CXXFLAGS" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTING=OFF \
  -DSHADERC_SKIP_TESTS=ON \
  -DSHADERC_SKIP_EXAMPLES=ON \
  -DSHADERC_SKIP_EXECUTABLES=ON \
  -DSHADERC_SKIP_COPYRIGHT_CHECK=ON \
  -DSHADERC_ENABLE_SHARED_CRT=OFF \
  -DSPIRV_SKIP_EXECUTABLES=ON \
  -DSPIRV_SKIP_TESTS=ON \
  -DSPIRV_TOOLS_BUILD_STATIC=ON \
  -DENABLE_GLSLANG_BINARIES=OFF \
  -DGLSLANG_TESTS=OFF \
  -DGLSLANG_ENABLE_INSTALL=ON \
  -DENABLE_SPVREMAPPER=OFF \
  -DENABLE_HLSL=ON \
  -DENABLE_OPT=ON

log "building shaderc_combined + libs (this takes a while)"
ninja -C "$b" install

log "installed shaderc:"
ls -la "$SYSROOT"/lib/libshaderc* "$SYSROOT"/include/shaderc/shaderc.h 2>&1
