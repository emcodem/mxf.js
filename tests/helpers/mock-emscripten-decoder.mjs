// Mock emscripten module for WasmFfmpegDecoder tests: a bump allocator that tracks _malloc/_free
// call counts, used to verify the grow-only packet-buffer reuse pattern fixed for
// todo_transcode_stall_and_fallback.md Issue A (repeated malloc/free of a differently-sized input
// packet buffer on every decode() call fragmented the wasm heap, making allocation cost climb
// steadily over a session).
export let mallocCalls = 0;
export let freeCalls = 0;
export function resetCounts() { mallocCalls = 0; freeCalls = 0; }

const HEAP = new Uint8Array(1024 * 1024);
let nextPtr = 8; // avoid pointer 0 — WasmFfmpegDecoder treats a 0 return as malloc failure

export default async function createModule() {
  return {
    HEAPU8: HEAP,
    _malloc(n) {
      mallocCalls++;
      const p = nextPtr;
      nextPtr += n;
      return p;
    },
    _free(_ptr) {
      freeCalls++;
    },
    // WasmFfmpegDecoder calls mod.cwrap(name, ...) itself and invokes the returned function directly
    // — this mock doesn't need real wasm export wiring, just matching call signatures/return shapes.
    cwrap(name) {
      switch (name) {
        case 'dec_create': return () => 1; // non-zero "context handle"
        case 'dec_send_packet': return () => 0;
        case 'dec_receive_frame': return () => 0; // no frames ready — decode() always returns []
        case 'dec_frame_width': return () => 0;
        case 'dec_frame_height': return () => 0;
        case 'dec_get_rgba': return () => 0;
        case 'dec_frame_pict_type': return () => 0;
        case 'dec_free': return () => {};
        default: throw new Error(`mock cwrap: unexpected export "${name}"`);
      }
    },
  };
}
