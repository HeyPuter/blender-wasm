#!/usr/bin/env bash
# Build the full Cycles/Blender dependency stack to wasm-sysroot, in dependency
# order with parallelism inside each wave. Idempotent: each build_*.sh skips
# re-downloading and reconfigures from scratch. Invoked by `make deps`.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$ROOT"
SC="${SC:-$DEPS/logs}"; mkdir -p "$SC"
# Deps built concurrently within a wave. Each uses NPROC jobs, so the default
# (the whole wave at once) can mean dozens of compilers; lower it on a laptop.
DEP_JOBS="${DEP_JOBS:-64}"

wave() {  # wave <name> <script...>
  local name="$1"; shift
  echo "==== wave: $name ===="
  local pids=() s
  for s in "$@"; do
    # A dep that already built is kept (FORCE=1 rebuilds it), so a retry after
    # one failure does not recompile the waves before it.
    if [ "${FORCE:-0}" != 1 ] && [ "$(cat "$SC/$s.status" 2>/dev/null)" = 0 ]; then continue; fi
    # At most DEP_JOBS deps at once (each already runs NPROC compile jobs).
    while [ "$(jobs -rp | wc -l)" -ge "$DEP_JOBS" ]; do sleep 2; done
    ( bash "scripts/build_$s.sh" >"$SC/$s.log" 2>&1; echo "$?" >"$SC/$s.status" ) &
    pids+=($!)
  done
  # Guarded: a wave whose deps were all built already starts nothing, and an
  # empty "${pids[@]}" is an unbound variable under bash 3.2's set -u.
  if [ "${#pids[@]}" -gt 0 ]; then wait "${pids[@]}" || true; fi
  local fail=0 failed=()
  for s in "$@"; do
    local rc; rc=$(cat "$SC/$s.status" 2>/dev/null || echo 1)
    if [ "$rc" = 0 ]; then echo "  ok   $s"; else echo "  FAIL $s (rc=$rc, log: $SC/$s.log)"; fail=1; failed+=("$s"); fi
  done
  if [ "$fail" != 0 ]; then
    # Dump the failing deps' logs so the error is visible in CI (the log files
    # live on the runner and are otherwise lost).
    for s in "${failed[@]}"; do
      echo "======== last 80 lines of $s.log ========"
      tail -n 80 "$SC/$s.log" 2>/dev/null || echo "(no log)"
      echo "======== end $s.log ========"
    done
    echo "wave '$name' had failures"; exit 1
  fi
}

# Wave 1: no inter-deps.
# TBB is the thread pool: the single-threaded flavour (THREADS=0) builds
# Blender WITH_TBB=OFF and has no use for it.
TBB=tbb; [ "$THREADS" = 0 ] && TBB=
wave foundational zlib fmt imath zstd jpeg libdeflate robinmap yamlcpp expat pystring $TBB eigen pugixml brotli
# Wave 2: depend on wave 1.
wave mid png minizip openjph tiff
# Wave 3: FreeType (zlib + png + brotli). Blender's find_package(Freetype) is
# REQUIRED, so this must be in the sysroot before configure.
wave text freetype
# Wave 4: OpenEXR (Imath, libdeflate, openjph).
wave openexr openexr
# Wave 5: OpenColorIO (Imath, expat, yaml-cpp, pystring, minizip).
wave ocio ocio
# Wave 6: OpenImageIO (OpenEXR, OCIO, png, jpeg, fmt, robin-map, zstd).
wave oiio oiio

# --- WebGPU shader toolchain: GLSL --(shaderc)--> SPIR-V --(Tint)--> WGSL. -----
# Needed by the WITH_WEBGPU_BACKEND build/link (libtint_*.a, libSPIRV-Tools*.a,
# libshaderc_combined.a). Run one heavy build per wave (NOT parallel) so the
# huge Tint/shaderc/glslang compiles don't OOM the runner. Tint clones Dawn and
# must precede spirv_tools (which reuses Dawn's SPIRV-Tools source tree).
# GUI only, and the GUI is a pthread build: the single-threaded flavour is headless.
if [ "$THREADS" = 1 ]; then
  wave tint    tint
  wave spirv   spirv_tools
  wave shaderc shaderc
fi

echo "==== all deps built into $SYSROOT ===="
ls -1 "$SYSROOT"/lib/*.a
