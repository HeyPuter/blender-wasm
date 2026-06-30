#!/usr/bin/env bash
# Build the full Cycles/Blender dependency stack to wasm-sysroot, in dependency
# order with parallelism inside each wave. Idempotent: each build_*.sh skips
# re-downloading and reconfigures from scratch. Invoked by `make deps`.
set -euo pipefail
cd "$(dirname "$0")/.."
SC="${SC:-/tmp/blender-wasm-deplogs}"; mkdir -p "$SC"

wave() {  # wave <name> <script...>
  local name="$1"; shift
  echo "==== wave: $name ===="
  local pids=() s
  for s in "$@"; do
    ( bash "scripts/build_$s.sh" >"$SC/$s.log" 2>&1; echo "$?" >"$SC/$s.status" ) &
    pids+=($!)
  done
  wait "${pids[@]}" || true
  local fail=0
  for s in "$@"; do
    local rc; rc=$(cat "$SC/$s.status" 2>/dev/null || echo 1)
    if [ "$rc" = 0 ]; then echo "  ok   $s"; else echo "  FAIL $s (rc=$rc, log: $SC/$s.log)"; fail=1; fi
  done
  [ "$fail" = 0 ] || { echo "wave '$name' had failures"; exit 1; }
}

# Wave 1: no inter-deps.
wave foundational zlib fmt imath zstd jpeg libdeflate robinmap yamlcpp expat pystring tbb eigen pugixml
# Wave 2: depend on wave 1.
wave mid png minizip openjph tiff
# Wave 3: OpenEXR (Imath, libdeflate, openjph).
wave openexr openexr
# Wave 4: OpenColorIO (Imath, expat, yaml-cpp, pystring, minizip).
wave ocio ocio
# Wave 5: OpenImageIO (OpenEXR, OCIO, png, jpeg, fmt, robin-map, zstd).
wave oiio oiio

echo "==== all deps built into wasm-sysroot ===="
ls -1 wasm-sysroot/lib/*.a
