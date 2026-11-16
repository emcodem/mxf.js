/**
 * WasmFfmpegDecoder.decode() (src/codec/wasm-ffmpeg-decoder.ts): regression coverage for
 * todo_transcode_stall_and_fallback.md Issue A's WASM heap-fragmentation leak. Repeated
 * malloc/free of a differently-sized input-packet buffer on every call (real content: one call per
 * edit unit, a different byte length nearly every time) fragmented the emscripten heap's free list,
 * manifesting as decode cost climbing steadily over a session. Fixed with a grow-only reuse pattern
 * (same shape as the pre-existing `_rgbaPtr`/`_i420Ptr` output buffers) — this test locks that in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { WasmFfmpegDecoder } from '../src/codec/wasm-ffmpeg-decoder.js';
import * as mockModule from './helpers/mock-emscripten-decoder.mjs';

const MOCK_MODULE_URL = pathToFileURL(
  path.resolve(__dirname, 'helpers/mock-emscripten-decoder.mjs'),
).href;

describe('WasmFfmpegDecoder packet-buffer reuse', () => {
  beforeEach(() => mockModule.resetCounts());

  it('mallocs once for the first packet and reuses the pointer for same-or-smaller later packets', async () => {
    const decoder = await WasmFfmpegDecoder.load(MOCK_MODULE_URL, 'mock_codec');

    decoder.decode(new Uint8Array(1000));
    expect(mockModule.mallocCalls).toBe(1);
    expect(mockModule.freeCalls).toBe(0);

    // Same size again: no new allocation.
    decoder.decode(new Uint8Array(1000));
    expect(mockModule.mallocCalls).toBe(1);

    // Smaller: still fits in the existing buffer, no new allocation.
    decoder.decode(new Uint8Array(500));
    expect(mockModule.mallocCalls).toBe(1);
    expect(mockModule.freeCalls).toBe(0);
  });

  it('only reallocates (free + malloc) when a packet is larger than the current capacity', async () => {
    const decoder = await WasmFfmpegDecoder.load(MOCK_MODULE_URL, 'mock_codec');

    decoder.decode(new Uint8Array(1000));
    expect(mockModule.mallocCalls).toBe(1);
    expect(mockModule.freeCalls).toBe(0);

    decoder.decode(new Uint8Array(2000)); // grows
    expect(mockModule.mallocCalls).toBe(2);
    expect(mockModule.freeCalls).toBe(1);

    decoder.decode(new Uint8Array(2000)); // same as new capacity: no further growth
    expect(mockModule.mallocCalls).toBe(2);
    expect(mockModule.freeCalls).toBe(1);
  });

  it('never mallocs/frees a fresh buffer per call for a realistic varying-size sequence', async () => {
    const decoder = await WasmFfmpegDecoder.load(MOCK_MODULE_URL, 'mock_codec');
    // Simulates real per-frame packets: a different, mostly-smaller-or-equal size each call, with
    // a couple of growth spikes. The old (fixed) behavior would malloc AND free once per call (10
    // of each); the fix should only touch the allocator when capacity actually needs to grow —
    // here at 900 (initial), 920, and 1500 (three growths, not ten).
    const sizes = [900, 850, 920, 880, 1500, 1400, 1490, 1000, 1500, 1200];
    for (const size of sizes) decoder.decode(new Uint8Array(size));

    expect(mockModule.mallocCalls).toBe(3);
    expect(mockModule.freeCalls).toBe(2);
  });

  it('reset() frees the packet buffer and returns to a clean grow-from-zero state', async () => {
    const decoder = await WasmFfmpegDecoder.load(MOCK_MODULE_URL, 'mock_codec');
    decoder.decode(new Uint8Array(1000));
    expect(mockModule.mallocCalls).toBe(1);

    decoder.reset();
    expect(mockModule.freeCalls).toBe(1); // the packet buffer (and any output buffers) got freed

    decoder.decode(new Uint8Array(500));
    expect(mockModule.mallocCalls).toBe(2); // capacity was reset to 0, so this allocates again
  });
});
