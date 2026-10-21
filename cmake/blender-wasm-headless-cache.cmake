# Headless Blender → WASM, for driving `bpy` from Node or a browser worker.
#
# Same trimmed dependency set as blender-wasm-cache.cmake, but with the entire
# window/draw stack switched off. Callers only drive bpy: import_scene.gltf,
# object/mesh/modifier operations, export_scene.gltf. It never renders a pixel,
# so GHOST and the WebGPU backend — the parts of the upstream port that are still
# in progress — are dead weight here and are the main source of build risk.
#
# Passed via `cmake -C`, layered on top of the base cache.

include("${CMAKE_CURRENT_LIST_DIR}/blender-wasm-cache.cmake")

# --- no window, no draw backend -------------------------------------------
set(WITH_HEADLESS            ON  CACHE BOOL "" FORCE)
set(WITH_GHOST_WEB           OFF CACHE BOOL "" FORCE)
set(WITH_WEBGPU_BACKEND      OFF CACHE BOOL "" FORCE)
set(WITH_OPENGL_BACKEND      OFF CACHE BOOL "" FORCE)
set(WITH_VULKAN_BACKEND      OFF CACHE BOOL "" FORCE)
set(WITH_METAL_BACKEND       OFF CACHE BOOL "" FORCE)

# --- Cycles: needed for baking ---------------------------------------------
# Baking (AO, curvature, high->low normal transfer) is the backbone of a real
# asset pipeline and the one thing the modelling toolset cannot substitute for.
# EEVEE is the only engine otherwise, and it needs the GPU backend this build
# switches off. Flags mirror cycles-wasm-cache.cmake, which is this fork's
# expected-good set for wasm: CPU only, no Embree/OSL/OpenPGL (none are in the
# sysroot), no GPU device backends.
set(WITH_CYCLES               ON  CACHE BOOL "" FORCE)
set(WITH_CYCLES_DEVICE_CUDA   OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_DEVICE_OPTIX  OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_DEVICE_HIP    OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_DEVICE_ONEAPI OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_DEVICE_METAL  OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_CUDA_BINARIES OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_EMBREE        OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_OSL           OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_PATH_GUIDING  OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_LOGGING       OFF CACHE BOOL "" FORCE)
set(WITH_CYCLES_DEBUG         OFF CACHE BOOL "" FORCE)
set(WITH_NANOVDB              OFF CACHE BOOL "" FORCE)

# OpenImageIO is back ON: Cycles depends on it for image I/O, so it cannot be
# trimmed the way it could when this build only moved geometry.
set(WITH_OPENIMAGEIO         ON  CACHE BOOL "" FORCE)
set(WITH_IMAGE_CINEON        OFF CACHE BOOL "" FORCE)
set(WITH_IMAGE_WEBP          OFF CACHE BOOL "" FORCE)
