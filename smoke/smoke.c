// Toolchain smoke test: exercises the exact runtime features the headless
// Cycles render path will rely on — POSIX threads splitting work across cores
// and WASM SIMD doing the per-pixel math — then hands an RGBA buffer back to
// JS to blit onto a canvas. If this renders in the browser, the emsdk setup
// (pthreads + COOP/COEP + SIMD) is sound.
#include <emscripten.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <wasm_simd128.h>

#define W 512
#define H 512
#define MAXIT 256
#define NTHREADS 8

static uint8_t *g_pixels = NULL;

typedef struct {
  int y0, y1;
} band_t;

// Render a horizontal band of the Mandelbrot set. Two pixels are iterated at a
// time using a 128-bit SIMD lane pair (f64x2) to prove vectorization works.
static void *render_band(void *arg) {
  band_t *b = (band_t *)arg;
  for (int y = b->y0; y < b->y1; y++) {
    double ci = (y / (double)H) * 2.5 - 1.25;
    for (int x = 0; x < W; x += 2) {
      v128_t cr = wasm_f64x2_make((x / (double)W) * 3.0 - 2.0,
                                  ((x + 1) / (double)W) * 3.0 - 2.0);
      v128_t civ = wasm_f64x2_splat(ci);
      v128_t zr = wasm_f64x2_splat(0.0), zi = wasm_f64x2_splat(0.0);
      int it[2] = {0, 0};
      for (int i = 0; i < MAXIT; i++) {
        v128_t zr2 = wasm_f64x2_mul(zr, zr);
        v128_t zi2 = wasm_f64x2_mul(zi, zi);
        v128_t mag = wasm_f64x2_add(zr2, zi2);
        // lane escape test
        if (wasm_f64x2_extract_lane(mag, 0) <= 4.0) it[0]++;
        if (wasm_f64x2_extract_lane(mag, 1) <= 4.0) it[1]++;
        if (wasm_f64x2_extract_lane(mag, 0) > 4.0 &&
            wasm_f64x2_extract_lane(mag, 1) > 4.0)
          break;
        v128_t newzi = wasm_f64x2_add(
            wasm_f64x2_mul(wasm_f64x2_splat(2.0), wasm_f64x2_mul(zr, zi)), civ);
        zr = wasm_f64x2_add(wasm_f64x2_sub(zr2, zi2), cr);
        zi = newzi;
      }
      for (int k = 0; k < 2 && (x + k) < W; k++) {
        int idx = (y * W + (x + k)) * 4;
        uint8_t v = (uint8_t)(255 - it[k] * 255 / MAXIT);
        g_pixels[idx + 0] = (uint8_t)(it[k] * 9 % 256);
        g_pixels[idx + 1] = (uint8_t)(it[k] * 5 % 256);
        g_pixels[idx + 2] = v;
        g_pixels[idx + 3] = 255;
      }
    }
  }
  return NULL;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *render(void) {
  if (!g_pixels) g_pixels = (uint8_t *)malloc(W * H * 4);
  pthread_t th[NTHREADS];
  band_t bands[NTHREADS];
  int rows = H / NTHREADS;
  for (int i = 0; i < NTHREADS; i++) {
    bands[i].y0 = i * rows;
    bands[i].y1 = (i == NTHREADS - 1) ? H : (i + 1) * rows;
    pthread_create(&th[i], NULL, render_band, &bands[i]);
  }
  for (int i = 0; i < NTHREADS; i++) pthread_join(th[i], NULL);
  return g_pixels;
}

EMSCRIPTEN_KEEPALIVE int img_w(void) { return W; }
EMSCRIPTEN_KEEPALIVE int img_h(void) { return H; }

int main(void) { return 0; }
