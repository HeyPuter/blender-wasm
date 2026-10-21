#!/usr/bin/env bash
# Relink the headless Blender wasm module (no window, no GPU backend) for Node
# or for a browser worker. Requires the headless configure + compile:
#
#   ./build.sh node        (or: make blender-headless && TARGET=node bash scripts/link_blender_headless.sh)
#
# TARGET=node     -> node/blender.{js,wasm,data}      -sENVIRONMENT=node
# TARGET=browser  -> browser/blender.{js,wasm,data}   -sENVIRONMENT=web,worker
#
# The module is a factory, `createBlenderModule(config)`. Drive it with
# Blender's CLI arguments (`--background --factory-startup --python-expr …`);
# api/run-once.cjs is the reference driver for Node.
#
# Knobs: LINK_OPT (default -O1), ASSERTIONS (default 1), OUT (output dir).
#
# Why each setting is what it is:
#
# * Filesystem: assets are PRELOADED into the in-memory FS (blender.data), not
#   NODERAWFS. NODERAWFS swaps in node's synchronous fs, which does not work
#   across pthreads, and Blender is -pthread throughout: the module deadlocks at
#   startup. Files move in and out through the exported FS runtime methods.
#
# * MODULARIZE is required, not cosmetic. Without it the glue does
#     var Module = typeof Module != "undefined" ? Module : {};
#   which under require() hoists a module-scoped `Module`, shadows any global
#   one, and silently discards the caller's config — preRun never runs, so
#   BLENDER_SYSTEM_RESOURCES is never set and Blender cannot find its scripts.
#
# * MAIN_MODULE=1 enables emscripten's dlopen, which CPython's dynload_shlib
#   uses to load numpy's SIDE_MODULE extensions. =1, not =2: =2 prunes exports
#   to what it can prove is needed, dropping Python C-API *data* symbols numpy's
#   _multiarray_umath needs ('PyExc_ValueError'). Every input must be -fPIC.
#
# * Undefined symbols. Blender's link leaves ~99 undefined (CPython bz2/sqlite3
#   with no backing libs, the fork's two wgpu_* entry points, browser-only
#   WasmFS backends, execinfo). None are reachable under --background, but under
#   MAIN_MODULE the loader resolves them at load time and refuses to start, so
#   scripts/undef_symbols.txt is compiled into no-op stubs. With the stubs in
#   place ASSERTIONS can stay on.
#   After linking, any symbol still unresolved (the glue marks each with
#   `.stub = true`) is reported. Known and harmless: `daemon`, whose JS stub
#   only aborts if called. AUTO_STUB=1 appends new ones to the list and relinks.
#
# * PROXY_TO_PTHREAD runs main() on a worker so the JS thread stays free to
#   service emscripten's pthread messages. Without it a synchronous callMain()
#   deadlocks — it blocks the very thread the workers need.
#
# * main() never returns, so one module instance = one Blender run, and the
#   factory promise never settles. Callers detect completion from a sentinel in
#   the printed output (see api/run-once.cjs) and dispose of the process.
#
# * INITIAL_MEMORY is 256 MB, not the 1 GB of the GUI build: repeated 1 GB
#   instantiations exhaust V8's heap ("CALL_AND_RETRY_LAST Allocation failed"
#   inside WasmInstantiate). ALLOW_MEMORY_GROWTH covers larger scenes; callers
#   may also pass INITIAL_MEMORY in the factory config.
#
# * --allow-multiple-definition: CPython bundles expat (pyexpat) and OIIO pulls
#   the standalone libexpat; the two collide on xmlparse/xmltok. Deleting
#   CPython's copy instead corrupts its builtin module table (`import bpy` dies).
#
# * brotli: see EXTRA_LINK_LIBS in link_common.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/link_common.sh"

TARGET="${TARGET:-node}"
case "$TARGET" in
  node)       ENVIRONMENT=node ;;
  browser)    ENVIRONMENT=web,worker ;;
  browser-st) ENVIRONMENT=web,worker ;;
  *) die "TARGET must be node, browser or browser-st (got '$TARGET')" ;;
esac
# browser-st is the single-threaded build: its objects are THREADS=0 ones.
if [ "$TARGET" = browser-st ] && [ "$THREADS" != 0 ]; then die "browser-st links the THREADS=0 build (./build.sh browser-st)"; fi
if [ "$TARGET" != browser-st ] && [ "$THREADS" = 0 ]; then die "THREADS=0 links only browser-st"; fi
OUT="${OUT:-$ROOT/$TARGET}"
STAGE="$OUT/blender_assets"
LINK_OPT="${LINK_OPT:--O1}"
ASSERTIONS="${ASSERTIONS:-1}"
mkdir -p "$OUT"

# The headless configure is a different CMake cache than the GUI one; linking
# GUI objects here would pull in GHOST/WebGPU and fail in confusing ways.
grep -q '^WITH_HEADLESS:BOOL=ON' "$BLENDER_BUILD/CMakeCache.txt" 2>/dev/null \
  || die "$BLENDER_BUILD is not configured headless — run ./build.sh $TARGET (or make configure-blender-headless)"

stage_assets "$STAGE" python3.13
stage_cycles_addon "$STAGE"
python3 "$ROOT/scripts/patch_gltf_ctypes.py" "$STAGE"
stage_numpy "$STAGE/python3.13"
trim_headless_assets "$STAGE" python3.13
precompile_python "$STAGE/$BLENDER_VERSION_DIR/scripts" "$STAGE/python3.13"
log "scripts=$(du -shL "$STAGE/$BLENDER_VERSION_DIR/scripts"|cut -f1) datafiles=$(du -shL "$STAGE/$BLENDER_VERSION_DIR/datafiles"|cut -f1) py=$(du -sh "$STAGE/python3.13"|cut -f1)"


# Threads: the pthread build runs main() on a pthread (PROXY_TO_PTHREAD, above).
# The single-threaded build runs main() on the worker's own thread and gives
# the thread back with JSPI: Blender's poll loop (BLENDER_WASM_POLL, see
# patches/blender) suspends to the event loop between requests. JSPI cannot
# suspend through JS frames, which is why that build's ABI uses wasm
# exceptions and setjmp/longjmp (no invoke_* trampolines), and why only C
# suspends: CPython calls builtins through a JS trampoline where wasm type
# reflection is missing, so a Python-level suspension would trap.
if [ "$THREADS" = 0 ]; then
  THREAD_FLAGS="$ABI_FLAGS -sJSPI"
else
  THREAD_FLAGS="-pthread -sPROXY_TO_PTHREAD -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=4 -sPTHREAD_POOL_SIZE_STRICT=0"
fi

# LINK_NAMES=1 keeps function names (--profiling-funcs), so a trap's stack
# reads as Blender's functions rather than wasm-function[N].
NAME_FLAGS=""; [ "${LINK_NAMES:-0}" = 1 ] && NAME_FLAGS="--profiling-funcs"

# -lembind: the JavaScript API (blender source/creator/bw_api.cc, patches/blender).
FLAGS="$THREAD_FLAGS $NAME_FLAGS -lembind \
  -Wl,--allow-multiple-definition \
  -sEXIT_RUNTIME=0 \
  $LINK_OPT \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 \
  -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8,HEAPU16,HEAPF32 \
  -sENVIRONMENT=$ENVIRONMENT -sASSERTIONS=$ASSERTIONS -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sMODULARIZE=1 -sEXPORT_ES6=0 -sEXPORT_NAME=createBlenderModule \
  -sMAIN_MODULE=1 \
  --preload-file $STAGE/$BLENDER_VERSION_DIR@/$BLENDER_VERSION_DIR \
  --preload-file $STAGE/python3.13@$SYSROOT/lib/python3.13"

link_once() {
  local cmd stub
  cmd=$(cmake_link_cmd "$OUT/blender.js")
  stub=$(undef_stub_object)
  log "relinking blender -> $OUT/blender.js ($TARGET, headless, $LINK_OPT)"
  ( cd "$BLENDER_BUILD" && eval "$cmd $EXTRA_LINK_LIBS $stub $FLAGS" ) 2>&1 | tee "$OUT/link.log"
}

# Unresolved symbols the glue stubs with an abort-on-call; `daemon` has always
# been one and is never called.
KNOWN_UNRESOLVED="${KNOWN_UNRESOLVED:-daemon}"
new_unresolved() {
  unresolved_symbols "$OUT/blender.js" | grep -vxF -f <(tr ' ' '\n' <<< "$KNOWN_UNRESOLVED") || true
}

link_once
missing=$(new_unresolved)
if [ -n "$missing" ]; then
  log "unresolved symbols not in $(basename "$UNDEF_TXT"):"
  echo "$missing" | sed 's/^/     /' >&2
  if [ "${AUTO_STUB:-0}" = 1 ]; then
    log "AUTO_STUB=1: adding them as no-op stubs and relinking"
    echo "$missing" >> "$UNDEF_TXT"
    link_once
  else
    log "if the module fails to load, add them to scripts/undef_symbols.txt (or rerun with AUTO_STUB=1)"
  fi
fi

ls -la "$OUT"/blender.js "$OUT"/blender.wasm "$OUT"/blender.data
log "done"
