/* A streaming brotli decoder as a standalone WebAssembly module, for pages
 * that receive .br files no server decoded (a CDN serving the npm package).
 * Built by scripts/build_brotli_decoder.sh; driven by the package's
 * src/browser/brotli.ts. Exports (all integers are wasm32 pointers/sizes):
 *
 *   bd_create() -> state              bd_destroy(state)
 *   bd_step(state, in, in_len, out, out_cap) -> result
 *     result: 0 error, 1 done, 2 needs more input, 3 needs more output
 *   bd_in_used() / bd_out_len()        what the last step consumed / produced
 *   malloc / free                      buffers for the above
 */
#include <brotli/decode.h>
#include <stdint.h>
#include <stdlib.h>

#define EXPORT(name) __attribute__((export_name(#name)))

static size_t in_used = 0;
static size_t out_len = 0;

EXPORT(bd_create) BrotliDecoderState *bd_create(void)
{
  return BrotliDecoderCreateInstance(NULL, NULL, NULL);
}

EXPORT(bd_destroy) void bd_destroy(BrotliDecoderState *state)
{
  BrotliDecoderDestroyInstance(state);
}

EXPORT(bd_step) int bd_step(BrotliDecoderState *state, const uint8_t *in, size_t in_len, uint8_t *out, size_t out_cap)
{
  size_t avail_in = in_len, avail_out = out_cap;
  const uint8_t *next_in = in;
  uint8_t *next_out = out;
  BrotliDecoderResult result = BrotliDecoderDecompressStream(state, &avail_in, &next_in, &avail_out, &next_out, NULL);
  in_used = in_len - avail_in;
  out_len = out_cap - avail_out;
  return (int)result;
}

EXPORT(bd_in_used) size_t bd_in_used(void) { return in_used; }
EXPORT(bd_out_len) size_t bd_out_len(void) { return out_len; }
EXPORT(bd_malloc) void *bd_malloc(size_t size) { return malloc(size); }
EXPORT(bd_free) void bd_free(void *ptr) { free(ptr); }
