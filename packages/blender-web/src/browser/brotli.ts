/**
 * Brotli in the page, for runtimes served as `.br` files that no server
 * decodes (a CDN serving the npm package as it is): browsers decode brotli
 * only as a Content-Encoding, and DecompressionStream has no brotli.
 *
 * `brotli-decode.wasm` (built from brotli's own decoder,
 * scripts/build_brotli_decoder.sh) is a standalone module with no imports
 * worth the name; each stream gets its own decoder state.
 */

interface DecoderExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  bd_create(): number;
  bd_destroy(state: number): void;
  bd_step(state: number, input: number, inputLength: number, output: number, outputCapacity: number): number;
  bd_in_used(): number;
  bd_out_len(): number;
  bd_malloc(size: number): number;
  bd_free(pointer: number): void;
}

const ERROR = 0;
const DONE = 1;
const NEEDS_INPUT = 2;
const IN_SIZE = 1 << 16;
const OUT_SIZE = 1 << 20;

function isDecoder(exports: WebAssembly.Exports): exports is WebAssembly.Exports & DecoderExports {
  return exports.memory instanceof WebAssembly.Memory
    && ["bd_create", "bd_destroy", "bd_step", "bd_in_used", "bd_out_len", "bd_malloc", "bd_free"]
      .every((name) => typeof exports[name] === "function");
}

export type BrotliDecoder = () => TransformStream<Uint8Array, Uint8Array>;

/** Loads the decoder module once; the result makes a decoding stream per call. */
export async function loadBrotliDecoder(url: string | URL): Promise<BrotliDecoder> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, { env: { emscripten_notify_memory_growth: () => {} } });
  const wasm = instance.exports;
  if (!isDecoder(wasm)) throw new Error(`${url} is not the brotli decoder`);
  wasm._initialize?.();

  return () => {
    const state = wasm.bd_create();
    const input = wasm.bd_malloc(IN_SIZE);
    const output = wasm.bd_malloc(OUT_SIZE);
    let result = NEEDS_INPUT;
    const release = (): void => {
      wasm.bd_free(input);
      wasm.bd_free(output);
      wasm.bd_destroy(state);
    };
    // Steps until the decoder wants more input (or is done), emitting what it produced.
    const drain = (pending: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void => {
      let offset = 0;
      do {
        const length = Math.min(IN_SIZE, pending.length - offset);
        // Views are made per step: memory growth detaches the old buffer.
        new Uint8Array(wasm.memory.buffer, input, length).set(pending.subarray(offset, offset + length));
        let used = 0;
        do {
          result = wasm.bd_step(state, input + used, length - used, output, OUT_SIZE);
          if (result === ERROR) throw new Error("brotli: corrupt input");
          used += wasm.bd_in_used();
          const produced = wasm.bd_out_len();
          if (produced) controller.enqueue(new Uint8Array(wasm.memory.buffer, output, produced).slice());
        } while (result !== DONE && (used < length || result !== NEEDS_INPUT));
        offset += length;
      } while (offset < pending.length && result !== DONE);
    };
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try {
          drain(chunk, controller);
        } catch (error) {
          release();
          throw error;
        }
      },
      flush() {
        release();
        if (result !== DONE) throw new Error("brotli: stream ended early");
      },
    });
  };
}
