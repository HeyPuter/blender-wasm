#!/usr/bin/env bash
# pugixml 1.14 → wasm-sysroot. Cycles' standalone XML scene loader (cycles_xml)
# needs it; without it util/xml.h leaves XMLReader/xml_node undefined.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/zeux/pugixml/releases/download/v1.14/pugixml-1.14.tar.gz" \
  "pugixml-1.14.tar.gz" "pugixml-1.14")
em_cmake "$src" pugixml \
  -DBUILD_SHARED_LIBS=OFF
log "done"
