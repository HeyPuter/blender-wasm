#!/usr/bin/env bash
# Eigen 3 (header-only) → wasm-sysroot. Blender 5.2 ships no bundled Eigen and
# requires find_package(Eigen3). Pinned to Blender's commit. Install only copies
# headers + Eigen3Config.cmake (no compilation), so the toolchain is irrelevant.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
REV=8a1083e9bf41b91fdea6546681f806154efdc25a
src=$(fetch_extract \
  "https://gitlab.com/libeigen/eigen/-/archive/$REV/eigen-$REV.tar.gz" \
  "eigen-$REV.tar.gz" "eigen-$REV")
em_cmake "$src" eigen \
  -DEIGEN_BUILD_DOC=OFF \
  -DBUILD_TESTING=OFF \
  -DEIGEN_BUILD_TESTING=OFF \
  -DEIGEN_BUILD_PKGCONFIG=ON \
  -DEIGEN_BUILD_BLAS=OFF \
  -DEIGEN_BUILD_LAPACK=OFF
# ^ Blender uses Eigen HEADERS only (Eigen3::Eigen). The bundled BLAS/LAPACK libs
# default ON for a top-level build and pull in Fortran (.f) sources: on a runner
# with gfortran installed (e.g. GitHub's ubuntu image) CMake enables Fortran and
# compiles them with the NATIVE gfortran, producing x86 ELF objects that wasm-ld
# then chokes on ("unknown file type: ...slarft.f.o"). Disabling both avoids
# Fortran entirely and installs just the headers we need.
log "done"
