# CMake initial-cache for the full Blender → WASM build (WITH_BLENDER=ON).
# Initial target: get DNA/RNA codegen running (host tools via node) + the core
# modules compiling. Headless for now (no GL/GHOST) to minimize configure walls;
# WebGPU backend + GUI come after the core builds. Passed via `cmake -C`.

set(WITH_BLENDER             ON  CACHE BOOL "")
set(WITH_PYTHON              ON  CACHE BOOL "")
set(WITH_PYTHON_MODULE       OFF CACHE BOOL "")
set(WITH_PYTHON_INSTALL      OFF CACHE BOOL "")
set(WITH_LIBS_PRECOMPILED    OFF CACHE BOOL "")
set(WITH_STRICT_BUILD_OPTIONS OFF CACHE BOOL "")

# --- our cross-compiled CPython 3.13 in the wasm sysroot -------------------
set(PYTHON_VERSION       "3.13" CACHE STRING "")
set(PYTHON_INCLUDE_DIR   "${CMAKE_SOURCE_DIR}/../wasm-sysroot/include/python3.13" CACHE PATH "")
set(PYTHON_INCLUDE_DIRS  "${CMAKE_SOURCE_DIR}/../wasm-sysroot/include/python3.13" CACHE PATH "")
set(PYTHON_LIBRARY       "${CMAKE_SOURCE_DIR}/../wasm-sysroot/lib/libpython3.13.a" CACHE FILEPATH "")
set(PYTHON_LIBPATH       "${CMAKE_SOURCE_DIR}/../wasm-sysroot/lib" CACHE PATH "")
set(WITH_PYTHON_NUMPY    OFF CACHE BOOL "")

# --- GPU: WebGPU backend (our gpu/webgpu/), no GL/Vulkan -------------------
# Headless GHOST (no window); EEVEE renders offscreen through the WebGPU device
# obtained from JS (emscripten_webgpu_get_device), bypassing GL/Vulkan context.
set(WITH_HEADLESS            OFF CACHE BOOL "")
set(WITH_GHOST_WEB           ON  CACHE BOOL "")
set(WITH_WEBGPU_BACKEND      ON  CACHE BOOL "")
set(WITH_OPENGL_BACKEND      OFF CACHE BOOL "")
set(WITH_VULKAN_BACKEND      OFF CACHE BOOL "")
set(WITH_GHOST_SDL           OFF CACHE BOOL "")
# The web GHOST backend is the only one; disable the desktop backends so their
# find_package(X11 REQUIRED) / Wayland probes don't wall a headless CI runner
# (they only passed locally because the dev box has libx11-dev installed).
set(WITH_GHOST_X11           OFF CACHE BOOL "")
set(WITH_GHOST_WAYLAND       OFF CACHE BOOL "")
set(WITH_OPENIMAGEDENOISE    OFF CACHE BOOL "")
set(WITH_INTERNATIONAL       OFF CACHE BOOL "")
set(WITH_HARFBUZZ            OFF CACHE BOOL "")
set(WITH_FRIBIDI            OFF CACHE BOOL "")

# --- trim heavy/irrelevant features to reach codegen fast ------------------
set(WITH_CYCLES              OFF CACHE BOOL "")
set(WITH_OPENVDB             OFF CACHE BOOL "")
set(WITH_OPENSUBDIV          OFF CACHE BOOL "")
set(WITH_OPENCOLORIO         OFF CACHE BOOL "")
set(WITH_OPENIMAGEIO         ON  CACHE BOOL "")
set(WITH_TBB                 ON  CACHE BOOL "")
set(WITH_TBB_MALLOC_PROXY    OFF CACHE BOOL "")
set(WITH_LIBMV               OFF CACHE BOOL "")
set(WITH_DRACO               OFF CACHE BOOL "")
set(WITH_MESHOPTIMIZER       OFF CACHE BOOL "")
set(WITH_MOD_FLUID           OFF CACHE BOOL "")
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
set(WITH_XR_OPENXR           OFF CACHE BOOL "")
set(WITH_ALEMBIC             OFF CACHE BOOL "")
set(WITH_USD                 OFF CACHE BOOL "")
set(WITH_HYDRA               OFF CACHE BOOL "")
set(WITH_MATERIALX           OFF CACHE BOOL "")

# emscripten ships arm_neon.h emulation → Blender's NEON probe misfires.
set(SUPPORTS_NEON_BUILD      FALSE CACHE INTERNAL "")
set(WITH_TESTS               OFF CACHE BOOL "")
set(WITH_GTESTS              OFF CACHE BOOL "")
set(CMAKE_INSTALL_PREFIX     "${CMAKE_BINARY_DIR}/install" CACHE PATH "")
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH CACHE STRING "")
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH CACHE STRING "")
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH CACHE STRING "")
