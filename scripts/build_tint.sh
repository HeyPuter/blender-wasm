#!/usr/bin/env bash
# Build Tint (SPIR-V → WGSL transpiler, part of Dawn) to WASM static libs.
# Needed because emdawnwebgpu's browser bridge only accepts WGSL shader modules
# (verified: emwgpuDeviceCreateShaderModule handles only ShaderSourceWGSL), so
# Blender's GLSL → (shaderc) SPIR-V → (Tint) WGSL is the required path.
# Matches the Dawn revision bundled with the emdawnwebgpu port.
source "$(dirname "$0")/dep_common.sh"

DAWN_REV="${DAWN_REV:-31e25af254ab572c77054edec4946d2244e184dd}"

cd "$SRC"
if [ ! -d "$SRC/dawn" ]; then
  log "cloning dawn (shallow) @ $DAWN_REV"
  git clone https://dawn.googlesource.com/dawn "$SRC/dawn"
  ( cd "$SRC/dawn" && git fetch --depth 1 origin "$DAWN_REV" && git checkout -q FETCH_HEAD )
fi
cd "$SRC/dawn"

# Patch Tint's ICE handler to longjmp to a host-armed recovery point instead of
# trapping the whole wasm module on an unsupported shader (Blender's WebGPU
# backend arms this around Tint calls — see webgpu_shader.cc's use of
# tint::internal_compiler_error_recovery). Idempotent: only applied when the
# declaration isn't already present.
if ! grep -q "internal_compiler_error_recovery" src/tint/utils/ice/ice.h; then
  log "applying tint ICE-recovery patch"
  git apply "$ROOT/scripts/patches/tint-ice-recovery.patch"
fi

# Fetch only the deps Tint needs (no gclient): abseil, SPIRV-Tools, SPIRV-Headers.
# NOTE: guard on a real file (abseil's CMakeLists) not just the dir — an
# interrupted first fetch leaves empty dirs that would skip a needed re-fetch.
if [ ! -f "$SRC/dawn/third_party/abseil-cpp/CMakeLists.txt" ]; then
  log "fetching Dawn dependencies (abseil, spirv-tools, spirv-headers, ...)"
  python3 tools/fetch_dawn_dependencies.py
fi

b="$BLD/tint"
rm -rf "$b"

# Tint's SPIR-V reader pulls spirv-tools opt headers which include spirv-headers
# (OpenCLDebugInfo100.h etc.) and generated tables; those include dirs are not
# propagated to the reader target when built in isolation. Add them globally.
SPVH="$SRC/dawn/third_party/spirv-headers/src/include"
SPVT="$SRC/dawn/third_party/spirv-tools/src"
EXTRA_INC="-I$SPVH -I$SPVH/spirv/unified1 -I$SPVT -I$SPVT/include -I$b/third_party/spirv-tools"

log "configuring Tint (emcmake) — SPV reader + WGSL writer only"
emcmake cmake -S "$SRC/dawn" -B "$b" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DCMAKE_C_FLAGS="$WASM_CFLAGS -Wno-error -Wno-deprecated-pragma $EXTRA_INC" \
  -DCMAKE_CXX_FLAGS="$WASM_CXXFLAGS -Wno-error -Wno-deprecated-pragma $EXTRA_INC" \
  -DBUILD_SHARED_LIBS=OFF \
  -DDAWN_ENABLE_INSTALL=OFF \
  -DDAWN_BUILD_SAMPLES=OFF \
  -DDAWN_BUILD_TESTS=OFF \
  -DTINT_BUILD_TESTS=OFF \
  -DTINT_BUILD_CMD_TOOLS=OFF \
  -DTINT_BUILD_IR_BINARY=OFF \
  -DTINT_BUILD_SPV_READER=ON \
  -DTINT_BUILD_WGSL_WRITER=ON \
  -DTINT_BUILD_WGSL_READER=OFF \
  -DTINT_BUILD_SPV_WRITER=OFF \
  -DTINT_BUILD_GLSL_WRITER=OFF \
  -DTINT_BUILD_GLSL_VALIDATOR=OFF \
  -DTINT_BUILD_HLSL_WRITER=OFF \
  -DTINT_BUILD_MSL_WRITER=OFF \
  -DDAWN_ENABLE_D3D12=OFF -DDAWN_ENABLE_METAL=OFF -DDAWN_ENABLE_VULKAN=OFF \
  -DDAWN_ENABLE_OPENGLES=OFF -DDAWN_ENABLE_DESKTOP_GL=OFF -DDAWN_ENABLE_NULL=OFF \
  -DDAWN_USE_GLFW=OFF \
  -DTINT_BUILD_BENCHMARKS=OFF

# Pre-generate SPIRV-Tools grammar tables (no ninja rule emits them) and place
# them next to table2.h so its quote-include resolves during compilation.
SPVT_SRC="$SRC/dawn/third_party/spirv-tools/src"
GDIR="$SRC/dawn/third_party/spirv-headers/src/include/spirv/unified1"
log "generating SPIRV-Tools core grammar tables (ggt.py)"
python3 "$SPVT_SRC/utils/ggt.py" \
  --core-tables-body-output="$SPVT_SRC/source/core_tables_body.inc" \
  --core-tables-header-output="$SPVT_SRC/source/core_tables_header.inc" \
  --spirv-core-grammar="$GDIR/spirv.core.grammar.json" \
  --extinst=,"$GDIR/extinst.glsl.std.450.grammar.json" \
  --extinst=,"$GDIR/extinst.opencl.std.100.grammar.json" \
  --extinst=CLDEBUG100_,"$GDIR/extinst.opencl.debuginfo.100.grammar.json" \
  --extinst=SHDEBUG100_,"$GDIR/extinst.nonsemantic.shader.debuginfo.grammar.json" \
  --extinst=,"$GDIR/extinst.spv-amd-shader-explicit-vertex-parameter.grammar.json" \
  --extinst=,"$GDIR/extinst.spv-amd-shader-trinary-minmax.grammar.json" \
  --extinst=,"$GDIR/extinst.spv-amd-gcn-shader.grammar.json" \
  --extinst=,"$GDIR/extinst.spv-amd-shader-ballot.grammar.json" \
  --extinst=,"$GDIR/extinst.debuginfo.grammar.json" \
  --extinst=,"$GDIR/extinst.nonsemantic.clspvreflection.grammar.json" \
  --extinst=,"$GDIR/extinst.nonsemantic.vkspreflection.grammar.json" \
  --extinst=TOSA_,"$GDIR/extinst.tosa.001000.1.grammar.json" \
  --extinst=,"$GDIR/extinst.arm.motion-engine.100.grammar.json" || log "ggt.py note: $?"

log "building default (all) — builds spirv-tools incl -opt transitively"
ninja -C "$b" 2>&1 | tail -8
log "building tint libraries (EXCLUDE_FROM_ALL targets)"
ninja -C "$b" tint_api tint_lang_spirv_reader tint_lang_wgsl_writer 2>&1 | tail -10
log "libs built — libtint*.a: $(find "$b" -name 'libtint*.a' 2>/dev/null | wc -l), libSPIRV*.a: $(find "$b" -name 'libSPIRV*.a' 2>/dev/null | wc -l)"
find "$b" -name "libSPIRV-Tools-opt.a" 2>/dev/null | sed 's#.*/##'
