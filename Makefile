# Blender → WebAssembly build orchestration.
#
# Reproducible from scratch:  make all
# Target MVP: headless Cycles CPU rendering in the browser, then scene
# loading/manipulation, then GUI (WebGL2). WebGPU backend is out of scope for now.
#
# Emscripten decisions baked in here:
#   * pthreads enabled            (-pthread, requires COOP/COEP on the web server)
#   * WASMFS + preload for assets (-sWASMFS, --preload-file)
#   * NO JSPI                     (avoid -sASYNCIFY/JSPI unless forced)
#   * OffscreenCanvas             (-sOFFSCREENCANVAS_SUPPORT)

ROOT          := $(CURDIR)
BLENDER_URL   := https://github.com/HeyPuter/blender
BLENDER_REF   := 6b031d3d41c392883e3c495aa72343e10d15b43d
# NOTE: ':=' (not '?=') so a stale exported EMSDK in the environment cannot
# point us at the wrong tree. Command-line `make EMSDK=...` still overrides.
EMSDK         := $(ROOT)/emsdk
EMSDK_VERSION := 6.0.1

# --- emscripten toolchain handles ------------------------------------------
EM_BIN        := $(EMSDK)/upstream/emscripten
EMCC          := $(EM_BIN)/emcc
EMXX          := $(EM_BIN)/em++
EMCMAKE       := $(EM_BIN)/emcmake
EMMAKE        := $(EM_BIN)/emmake
EM_TOOLCHAIN  := $(EM_BIN)/cmake/Modules/Platform/Emscripten.cmake
# `emcmake cmake ...` needs emcc/em++/emcmake on PATH. Sourcing emsdk_env.sh is
# unreliable when a stale EMSDK is already exported in the environment, so just
# prepend the toolchain bindir directly (emcc finds node via its own config).
EM_ENV        := export PATH="$(EM_BIN):$$PATH";

# --- layout (keep comments off these lines: trailing spaces leak into values) -
# SYSROOT      : install prefix for cross-compiled deps
# DEPS         : dep sources + build trees
# BUILD_CYCLES : cmake build dir for cycles standalone
# WEB          : html/js harness + final artifacts
SYSROOT       := $(ROOT)/wasm-sysroot
DEPS          := $(ROOT)/deps
BUILD_CYCLES  := $(ROOT)/build-cycles
WEB           := $(ROOT)/web
NPROC         := $(shell nproc)

# --- common compile flags for every wasm object (deps + blender) -----------
# Keep these identical across all libraries or linking will fail: pthreads,
# exceptions and SIMD must agree. SSE4.2 intrinsics are emulated onto wasm SIMD.
WASM_CFLAGS   := -O2 -pthread -msimd128 -msse4.2 -fexceptions
WASM_CXXFLAGS := $(WASM_CFLAGS)

.PHONY: all mvp toolchain blender blender-assets deps configure-cycles cycles cycles-web configure-blender blender-web verify-blender-webgpu web smoke serve verify verify-render verify-webgpu clean-build print-env

all: toolchain blender

# One command, from scratch, to the headless-Cycles-CPU-render MVP: toolchain →
# source → patches → deps → build → web relink → Playwright render verification.
mvp: cycles-web verify-render

# ---------------------------------------------------------------------------
# Toolchain: local, patchable emsdk pinned to $(EMSDK_VERSION).
# ---------------------------------------------------------------------------
toolchain: $(EMCC)
$(EMCC):
	@if [ ! -x "$(EMSDK)/emsdk" ]; then \
		echo ">> cloning emsdk -> $(EMSDK)"; \
		git clone https://github.com/emscripten-core/emsdk.git "$(EMSDK)"; \
	fi
	cd "$(EMSDK)" && ./emsdk install $(EMSDK_VERSION) && ./emsdk activate $(EMSDK_VERSION)
	# >> patch emsdk here if needed <<
	@test -x "$(EMCC)" && echo ">> emcc ready: $(EMCC)"

print-env:
	@echo "EMSDK=$(EMSDK)"; "$(EMCC)" --version | head -1

# ---------------------------------------------------------------------------
# Blender source (pinned fork ref).
# ---------------------------------------------------------------------------
blender: blender/.git
blender/.git:
	git init -q blender
	git -C blender remote add origin $(BLENDER_URL) 2>/dev/null || true
	GIT_LFS_SKIP_SMUDGE=1 git -C blender fetch --depth 1 origin $(BLENDER_REF)
	# Skip LFS smudge on checkout: the fork's GitHub LFS storage does NOT host the
	# LFS objects (forks don't inherit LFS), so smudging every pointer 404s and
	# aborts the checkout. Check out pointers; the real objects are pulled from
	# upstream by content hash in `blender-assets` below.
	GIT_LFS_SKIP_SMUDGE=1 git -C blender checkout -q --detach FETCH_HEAD
	@echo ">> blender at $$(git -C blender rev-parse --short HEAD)"

# Git-LFS datafiles (startup.blend, fonts, icons, colormanagement) needed by the
# FULL Blender build. The GitHub fork ($(BLENDER_URL)) DOES host these objects in
# its LFS storage and serves them anonymously, so pull from `origin` (default
# lfs.url). NOTE: do NOT point lfs.url at projects.blender.org — that endpoint
# requires authentication and fails in CI. The checkout above skips smudge, so
# these pointers are materialized here.
# (The essentials `assets/brushes/**` blends are the ONE thing not hosted on any
# anonymous LFS — 404 on every fork and auth-gated upstream — so they are
# vendored in-repo and bundled by scripts/link_blender_release.sh instead.)
blender-assets: blender
	cd blender && git lfs install --local 2>/dev/null || true
	cd blender && git lfs pull --include="release/datafiles/**"
	@echo ">> release/datafiles LFS pulled ($$(du -sh blender/release/datafiles | cut -f1))"

# ---------------------------------------------------------------------------
# Dependencies → $(SYSROOT). Built by per-dep scripts/build_<dep>.sh sharing
# scripts/dep_common.sh; all use the same ABI flags (pthreads/exceptions) so
# they link together. `make deps` runs them in dependency-ordered waves.
# Full set: zlib fmt imath zstd jpeg png libdeflate robinmap openjph openexr
#           tbb yamlcpp expat pystring minizip ocio oiio
# ---------------------------------------------------------------------------
deps: toolchain
	bash scripts/build_all_deps.sh

# Build (or rebuild) a single dependency, e.g.  make dep-oiio
dep-%: toolchain
	bash scripts/build_$*.sh

# ---------------------------------------------------------------------------
# Cycles standalone (headless CPU renderer).
# ---------------------------------------------------------------------------
# NOTE: the WASM source patches (host-tool codegen, makesdna alignment, sizeof
# asserts, etc.) are now committed in the fork and pulled by `make blender`, so
# there is no separate patch step.

# Cycles objects must be built with -pthread (enables atomics/bulk-memory) to
# match the deps and allow the shared-memory (pthreads) link. NOT -msimd128: it
# makes OpenImageIO's simd.h take an x86 SSE-intrinsic path (__m128i) that fails
# on wasm. Cycles' own kernel files add per-file SIMD flags as needed. Plus the
# wasm compat shim (uint/ushort).
WASM_COMPAT := -pthread -fexceptions -include $(ROOT)/cmake/wasm_compat.h

configure-cycles: toolchain blender deps
	$(EM_ENV) "$(EMCMAKE)" cmake -S blender -B $(BUILD_CYCLES) -G Ninja \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_PREFIX_PATH="$(SYSROOT)" \
		-DCMAKE_FIND_ROOT_PATH="$(SYSROOT)" \
		-DCMAKE_C_FLAGS="$(WASM_COMPAT)" \
		-DCMAKE_CXX_FLAGS="$(WASM_COMPAT)" \
		-C $(ROOT)/cmake/cycles-wasm-cache.cmake

# Build the cycles standalone wasm module (CMake links a non-web bin/cycles.js).
cycles: configure-cycles
	$(EM_ENV) ninja -C $(BUILD_CYCLES) cycles

# Relink the module with web-ready flags → web/cycles.{js,wasm,data}.
cycles-web: cycles
	bash scripts/link_cycles_web.sh

# ---------------------------------------------------------------------------
# Full Blender (WITH_BLENDER=ON) → WASM. In progress; gates the WebGPU backend
# and .blend loading. Needs CPython (make dep-python) + the dep stack + LFS
# datafiles. Host codegen tools (makesdna/makesrna/datatoc/shader_tool) run via
# node (wiring committed in the fork). Build dir: build-blender.
# ---------------------------------------------------------------------------
configure-blender: toolchain blender blender-assets deps dep-python
	bash scripts/build_shader_tool_native.sh   # native codegen tool (wasm one is buggy)
	$(EM_ENV) "$(EMCMAKE)" cmake -S blender -B build-blender -G Ninja \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_PREFIX_PATH="$(SYSROOT)" -DCMAKE_FIND_ROOT_PATH="$(SYSROOT)" \
		-DCMAKE_C_FLAGS="-pthread -fexceptions $(WASM_COMPAT)" \
		-DCMAKE_CXX_FLAGS="-pthread -fexceptions $(WASM_COMPAT)" \
		-DWITH_WEBGPU_BACKEND=ON \
		-C $(ROOT)/cmake/blender-wasm-cache.cmake

# ---------------------------------------------------------------------------
# Full Blender → browser (WebGPU). Web-relink the built blender objects with
# WASMFS + asset preload + web environment, then verify in chromium+SwiftShader
# that the render pipeline acquires a REAL WebGPU device handed in from JS.
# (EEVEE pixels need the rest of the WebGPU backend; this proves the device path.)
# ---------------------------------------------------------------------------
blender-web:
	bash scripts/link_blender_web.sh

verify-blender-webgpu: blender-web
	node scripts/verify_blender_webgpu.mjs

# ---------------------------------------------------------------------------
# Toolchain smoke test: pthreads + SIMD → canvas, proven via Playwright.
# ---------------------------------------------------------------------------
SMOKE_FLAGS := -O2 -pthread -msimd128 -msse4.2 -sPTHREAD_POOL_SIZE=8 \
	-sWASMFS -sOFFSCREENCANVAS_SUPPORT -sALLOW_MEMORY_GROWTH=1 \
	-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8 \
	-sEXPORTED_FUNCTIONS=_render,_img_w,_img_h,_main,_malloc

smoke: toolchain
	$(EM_ENV) "$(EMCC)" smoke/smoke.c -o $(WEB)/smoke.js $(SMOKE_FLAGS)

serve:
	node scripts/serve.mjs $(WEB) 8080

# Playwright verification. Defaults to the smoke page; override:
#   make verify PAGE=render.html TITLE="RENDER OK"
PAGE  ?= smoke.html
TITLE ?= SMOKE OK
verify:
	node scripts/verify.mjs $(PAGE) "$(TITLE)"

# Verify the headless Cycles CPU render in-browser (screenshots web/verify-shot.png).
verify-render:
	node scripts/verify.mjs render.html "RENDER OK"

# WebGPU availability checks (uses the FULL chromium build + bundled SwiftShader
# software Vulkan ICD — there is no GPU on the box). (1) browser JS compute,
# (2) wasm→WebGPU compute via emdawnwebgpu, NO JSPI. De-risks the EEVEE/WebGPU plan.
verify-webgpu: web/wgpu_compute.js web/wgpu_triangle.js
	node scripts/verify_webgpu.mjs webgpu-probe.html "WEBGPU OK"
	node scripts/verify_webgpu.mjs wgpu-wasm.html "WGPU WASM OK"
	node scripts/verify_webgpu.mjs wgpu-tri.html "WGPU TRI OK"

WGPU_PROBE_FLAGS := --use-port=emdawnwebgpu -sASYNCIFY=0 -sASSERTIONS=1 -O2 -sENVIRONMENT=web
web/wgpu_compute.js: smoke/wgpu_compute.c toolchain
	$(EM_ENV) "$(EMCC)" smoke/wgpu_compute.c -o $@ $(WGPU_PROBE_FLAGS)
web/wgpu_triangle.js: smoke/wgpu_triangle.c toolchain
	$(EM_ENV) "$(EMCC)" smoke/wgpu_triangle.c -o $@ $(WGPU_PROBE_FLAGS)

clean-build:
	rm -rf $(BUILD_CYCLES)
