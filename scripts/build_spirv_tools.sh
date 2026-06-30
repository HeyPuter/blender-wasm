#!/usr/bin/env bash
# Build Dawn's SPIRV-Tools (incl. the Dawn-specific opt passes
# SplitCombinedImageSamplerPass / ResolveBindingConflictsPass that Tint's SPIR-V
# reader needs) to WASM static libs, via SPIRV-Tools' OWN standalone CMake.
# Dawn's CMake wrapper does NOT emit the SPIRV-Tools-opt target (EXCLUDE_FROM_ALL
# + nothing pulls it), so we build it standalone from the same source tree.
#
# NOTE: as of this writing the resulting libSPIRV-Tools-opt.a links into the
# GLSL->SPIR-V->WGSL probe but a wasm call_indirect signature mismatch occurs at
# SplitCombinedImageSamplerPass::Run (a virtual call) — an ABI/vtable mismatch
# between Tint's parser.cc (compiled inside the Dawn/Tint build) and this
# separately-compiled opt lib. The real fix is to compile both in the SAME build
# context (identical flags/macros). See full-blender-wasm-progress memory.
source "$(dirname "$0")/dep_common.sh"

ST="$SRC/dawn/third_party/spirv-tools/src"
SH="$SRC/dawn/third_party/spirv-headers/src"
[ -d "$ST" ] || { echo "ERROR: build_tint.sh must run first (clones Dawn+deps)"; exit 1; }

# Match Tint's ABI flags (-pthread -msimd128 -fexceptions).
FLAGS="-O2 -pthread -msimd128 -fexceptions -Wno-error"
b="$BLD/spirv-tools"
rm -rf "$b"
log "configuring SPIRV-Tools standalone (emcmake)"
emcmake cmake -S "$ST" -B "$b" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DSPIRV-Headers_SOURCE_DIR="$SH" \
  -DSPIRV_SKIP_EXECUTABLES=ON -DSPIRV_SKIP_TESTS=ON \
  -DSPIRV_TOOLS_BUILD_STATIC=ON -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_CXX_FLAGS="$FLAGS"

log "building SPIRV-Tools-static + SPIRV-Tools-opt"
ninja -C "$b" SPIRV-Tools-static SPIRV-Tools-opt 2>&1 | tail -6
log "libs:"
find "$b" -name "libSPIRV-Tools*.a" 2>/dev/null | sed 's#.*/##' | sort -u
