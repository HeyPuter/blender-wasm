# CMake initial-cache for the headless Cycles-standalone WASM build.
# Passed via `cmake -C`. Goal: smallest possible Cycles CPU renderer.
# Everything GPU-device, optional-format, and Blender-app related is OFF.

# --- top-level target selection -------------------------------------------
set(WITH_BLENDER             OFF CACHE BOOL "")
set(WITH_CYCLES_STANDALONE   ON  CACHE BOOL "")
set(WITH_CYCLES_STANDALONE_GUI OFF CACHE BOOL "")   # no SDL/GL window
set(WITH_PYTHON_MODULE       OFF CACHE BOOL "")
set(WITH_PYTHON              OFF CACHE BOOL "")

# --- headless: no GPU graphics backend at all (CPU render only) ------------
set(WITH_OPENGL_BACKEND      OFF CACHE BOOL "")
set(WITH_VULKAN_BACKEND      OFF CACHE BOOL "")
set(WITH_GPU_BACKEND_TESTS   OFF CACHE BOOL "")
set(WITH_GHOST_SDL           OFF CACHE BOOL "")
set(WITH_GHOST_X11           OFF CACHE BOOL "")
set(WITH_GHOST_WAYLAND       OFF CACHE BOOL "")
set(WITH_XR_OPENXR           OFF CACHE BOOL "")
# No text/UI in headless Cycles → no FreeType/HarfBuzz/Fribidi.
set(WITH_INTERNATIONAL       OFF CACHE BOOL "")
set(WITH_HARFBUZZ            OFF CACHE BOOL "")
set(WITH_FRIBIDI            OFF CACHE BOOL "")
set(WITH_SYSTEM_FREETYPE     OFF CACHE BOOL "")

# --- no precompiled libs: use our wasm-sysroot via CMAKE_PREFIX_PATH --------
set(WITH_LIBS_PRECOMPILED    OFF CACHE BOOL "")
set(WITH_STRICT_BUILD_OPTIONS OFF CACHE BOOL "")

# --- Cycles GPU devices: all OFF (CPU only) --------------------------------
set(WITH_CYCLES_DEVICE_CUDA   OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_OPTIX  OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_HIP    OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_ONEAPI OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_METAL  OFF CACHE BOOL "")
set(WITH_CYCLES_CUDA_BINARIES OFF CACHE BOOL "")

# --- Cycles optional features that drag in heavy deps: OFF ------------------
set(WITH_CYCLES_EMBREE        OFF CACHE BOOL "")   # Embree
set(WITH_CYCLES_OSL           OFF CACHE BOOL "")   # OpenShadingLanguage + LLVM
set(WITH_CYCLES_PATH_GUIDING  OFF CACHE BOOL "")   # OpenPGL
set(WITH_OPENVDB              OFF CACHE BOOL "")
set(WITH_NANOVDB              OFF CACHE BOOL "")
set(WITH_OPENSUBDIV           OFF CACHE BOOL "")
set(WITH_OPENIMAGEDENOISE     OFF CACHE BOOL "")
set(WITH_OPENCOLORIO          OFF CACHE BOOL "")   # try without; re-enable if forced
set(WITH_ALEMBIC             OFF CACHE BOOL "")
set(WITH_USD                 OFF CACHE BOOL "")
set(WITH_HYDRA               OFF CACHE BOOL "")
set(WITH_MATERIALX           OFF CACHE BOOL "")

# --- mandatory for Cycles standalone ---------------------------------------
set(WITH_OPENIMAGEIO         ON  CACHE BOOL "")
set(WITH_TBB                 ON  CACHE BOOL "")
set(WITH_TBB_MALLOC_PROXY    OFF CACHE BOOL "")   # no global malloc replace on wasm
set(WITH_PUGIXML             ON  CACHE BOOL "")    # bundled in extern/

# emscripten's clang ships an arm_neon.h SIMD-emulation header, so Blender's
# test_neon_support() compiles and wrongly thinks this is ARM (→ requires
# sse2neon). Pre-define it FALSE to skip the probe; wasm is neither ARM nor x86.
set(SUPPORTS_NEON_BUILD      FALSE CACHE INTERNAL "")

# --- disable Blender-app features that drag in deps we don't need for a -----
# --- headless CPU renderer (motion tracking, audio, codecs, mesh tools…) ----
set(WITH_LIBMV               OFF CACHE BOOL "")   # Ceres
set(WITH_DRACO               OFF CACHE BOOL "")
set(WITH_MESHOPTIMIZER       OFF CACHE BOOL "")
set(WITH_MOD_FLUID           OFF CACHE BOOL "")
set(WITH_MOD_REMESH          OFF CACHE BOOL "")
set(WITH_AUDASPACE           OFF CACHE BOOL "")
set(WITH_CODEC_FFMPEG        OFF CACHE BOOL "")
set(WITH_CODEC_SNDFILE       OFF CACHE BOOL "")
set(WITH_SDL                 OFF CACHE BOOL "")
set(WITH_JACK                OFF CACHE BOOL "")
set(WITH_PULSEAUDIO          OFF CACHE BOOL "")
set(WITH_OPENAL              OFF CACHE BOOL "")
set(WITH_FFTW3               OFF CACHE BOOL "")
set(WITH_IMAGE_OPENJPEG      OFF CACHE BOOL "")
set(WITH_GMP                 OFF CACHE BOOL "")
set(WITH_POTRACE             OFF CACHE BOOL "")
set(WITH_HARU                OFF CACHE BOOL "")
set(WITH_MANIFOLD            OFF CACHE BOOL "")
set(WITH_QUADRIFLOW          OFF CACHE BOOL "")
set(WITH_INPUT_NDOF          OFF CACHE BOOL "")
set(WITH_BULLET              OFF CACHE BOOL "")
set(WITH_COMPOSITOR_CPU      OFF CACHE BOOL "")

# --- misc trims ------------------------------------------------------------
set(WITH_CYCLES_LOGGING      OFF CACHE BOOL "")
set(WITH_CYCLES_DEBUG        OFF CACHE BOOL "")
set(WITH_TESTS               OFF CACHE BOOL "")
set(WITH_GTESTS              OFF CACHE BOOL "")
set(WITH_DOC_MANPAGE         OFF CACHE BOOL "")
set(CMAKE_INSTALL_PREFIX     "${CMAKE_BINARY_DIR}/install" CACHE PATH "")

# Let emscripten cross-find our libs but still use the emsdk sysroot for system.
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH CACHE STRING "")
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH CACHE STRING "")
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH CACHE STRING "")
