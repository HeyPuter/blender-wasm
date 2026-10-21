#!/usr/bin/env bash
# Build Blender's GLSL/BSL shader-info preprocessor (shader_tool) NATIVELY.
#
# shader_tool is self-contained (only its own sources + the bundled lexit lexer +
# std C++ — no BLI/Blender deps), so unlike makesdna/makesrna it builds natively
# in seconds. Its wasm build has a lexer bug (scope-type misdetection → rejects
# valid `[[smooth]]` attributes), but native works perfectly. The full-Blender
# wasm build runs this native binary for shader codegen (the macros.cmake wiring,
# blender_wasm_host_tool_native(shader_tool, …), is committed in the fork).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
ST="$BLENDER_SRC/source/blender/gpu/shader_tool"
CXX_HOST="${CXX_HOST:-$(command -v clang++ || command -v g++)}"

SDK_FLAG=""
if [ "$(uname -s)" = "Darwin" ]; then
  SDKROOT="$(xcrun --show-sdk-path 2>/dev/null || true)"
  [ -n "$SDKROOT" ] && SDK_FLAG="-isysroot $SDKROOT"
fi

mkdir -p "$SYSROOT/bin"
( cd "$ST"
  "$CXX_HOST" -std=c++20 -O2 $SDK_FLAG -I. -Ilexit $(ls *.cc) $(ls lexit/*.cc 2>/dev/null) \
    -o "$SYSROOT/bin/shader_tool" )
echo ">> built native shader_tool → $SYSROOT/bin/shader_tool"
"$SYSROOT/bin/shader_tool" --help >/dev/null 2>&1 || true
