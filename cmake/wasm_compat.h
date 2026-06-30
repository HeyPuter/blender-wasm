/* Force-included into every Blender/Cycles TU for the WASM build.
 *
 * Emscripten's musl libc only exposes the non-standard `uint`/`ushort`
 * typedefs under _GNU_SOURCE, and not every source file that relies on them
 * includes <sys/types.h> (e.g. intern/mikktspace/mikk_util.hh). On Linux glibc
 * these come in transitively; on wasm they don't. Pull the header and provide
 * the typedefs ourselves if still missing. Identical typedef redefinition is
 * legal in C11/C++11, so this is safe whether or not libc already defined them. */
#pragma once
#include <sys/types.h>
#if defined(__EMSCRIPTEN__)
typedef unsigned int uint;
typedef unsigned short ushort;

/* Emscripten's <fenv.h> is a stub: it provides FE_ALL_EXCEPT but not the
 * individual floating-point exception flags. Code that probes them (e.g.
 * blenlib/expr_pylike_eval.cc) won't compile. wasm has no FP-exception traps
 * anyway, so define them to 0 — fetestexcept(0) is a harmless no-op. */
#  ifndef FE_INVALID
#    define FE_INVALID 0
#  endif
#  ifndef FE_DIVBYZERO
#    define FE_DIVBYZERO 0
#  endif
#  ifndef FE_OVERFLOW
#    define FE_OVERFLOW 0
#  endif
#  ifndef FE_UNDERFLOW
#    define FE_UNDERFLOW 0
#  endif
#  ifndef FE_INEXACT
#    define FE_INEXACT 0
#  endif
#endif
