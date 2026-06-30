#!/usr/bin/env bash
# yaml-cpp 0.8.0 → wasm-sysroot (OpenColorIO config parsing).
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/jbeder/yaml-cpp/archive/refs/tags/0.8.0.tar.gz" \
  "yaml-cpp-0.8.0.tar.gz" "yaml-cpp-0.8.0")
em_cmake "$src" yamlcpp \
  -DYAML_CPP_BUILD_TESTS=OFF \
  -DYAML_CPP_BUILD_TOOLS=OFF \
  -DYAML_CPP_BUILD_CONTRIB=OFF \
  -DYAML_BUILD_SHARED_LIBS=OFF
log "done"
