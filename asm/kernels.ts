// AssemblyScript MPEG-2 pixel kernels → WebAssembly.
//
// These are BIT-EXACT ports of the pure-JS reference in src/codec/mpeg2-decoder.ts. The JS decoder
// stays the default + correctness oracle; this module is selected only when WASM (+ SIMD) is
// available. Parity is asserted against the JS implementation in tests/wasm-idct.test.ts — any
// divergence is a bug, not an "optimization".
//
// No GC / no allocation: scratch buffers are reserved as static data (memory.data) and exposed via
// pointer getters, so the module builds with `--runtime stub` and the caller drives everything by
// writing into linear memory. Build: `npm run asbuild`.

// ── IDCT scratch ────────────────────────────────────────────────────────────
// One 8×8 i32 input block and one 8×8 i32 output block. The caller writes premultiplied coefficients
// into SRC (exactly what the JS path puts in `blockData`), calls idct(), then reads DST (the pixel
// residual, == JS `pixelData`).
const SRC: usize = memory.data(64 * 4);
const DST: usize = memory.data(64 * 4);

export function idctSrcPtr(): i32 { return SRC as i32; }
export function idctDstPtr(): i32 { return DST as i32; }

// @ts-ignore: decorator
@inline function ld(base: usize, i: i32): i32 { return load<i32>(base + (<usize>i << 2)); }
// @ts-ignore: decorator
@inline function st(base: usize, i: i32, v: i32): void { store<i32>(base + (<usize>i << 2), v); }

/**
 * Two-pass row/column inverse DCT, scalar. Reads 64 i32 from SRC, writes 64 i32 to DST.
 * Mirrors `idct(src, dst)` in src/codec/mpeg2-decoder.ts exactly: same constants (473, 196, 362),
 * same `>> 8` rounding with `+128`, same dataflow. i32 wraps like JS `>>`-coerced arithmetic, and
 * the inputs are ranged (jsmpeg-derived) so intermediates stay within i32 — so the result is
 * identical to the JS float64-then-ToInt32 path.
 */
export function idct(): void {
  let b1: i32, b3: i32, b4: i32, b6: i32, b7: i32, tmp1: i32, tmp2: i32, m0: i32;
  let x0: i32, x1: i32, x2: i32, x3: i32, x4: i32, y3: i32, y4: i32, y5: i32, y6: i32, y7: i32;

  // Row pass: read SRC, write DST.
  for (let i = 0; i < 8; i++) {
    b1 = ld(SRC, 4 * 8 + i); b3 = ld(SRC, 2 * 8 + i) + ld(SRC, 6 * 8 + i); b4 = ld(SRC, 5 * 8 + i) - ld(SRC, 3 * 8 + i);
    tmp1 = ld(SRC, 1 * 8 + i) + ld(SRC, 7 * 8 + i); tmp2 = ld(SRC, 3 * 8 + i) + ld(SRC, 5 * 8 + i);
    b6 = ld(SRC, 1 * 8 + i) - ld(SRC, 7 * 8 + i); b7 = tmp1 + tmp2;
    m0 = ld(SRC, 0 * 8 + i);
    x4 = ((b6 * 473 - b4 * 196 + 128) >> 8) - b7;
    x0 = x4 - (((tmp1 - tmp2) * 362 + 128) >> 8);
    x1 = m0 - b1; x2 = (((ld(SRC, 2 * 8 + i) - ld(SRC, 6 * 8 + i)) * 362 + 128) >> 8) - b3; x3 = m0 + b1;
    y3 = x1 + x2; y4 = x3 + b3; y5 = x1 - x2; y6 = x3 - b3;
    y7 = -x0 - ((b4 * 473 + b6 * 196 + 128) >> 8);
    st(DST, 0 * 8 + i, b7 + y4); st(DST, 1 * 8 + i, x4 + y3); st(DST, 2 * 8 + i, y5 - x0); st(DST, 3 * 8 + i, y6 - y7);
    st(DST, 4 * 8 + i, y6 + y7); st(DST, 5 * 8 + i, x0 + y5); st(DST, 6 * 8 + i, y3 - x4); st(DST, 7 * 8 + i, y4 - b7);
  }
  // Column pass: in place on DST.
  for (let i = 0; i < 64; i += 8) {
    b1 = ld(DST, 4 + i); b3 = ld(DST, 2 + i) + ld(DST, 6 + i); b4 = ld(DST, 5 + i) - ld(DST, 3 + i);
    tmp1 = ld(DST, 1 + i) + ld(DST, 7 + i); tmp2 = ld(DST, 3 + i) + ld(DST, 5 + i);
    b6 = ld(DST, 1 + i) - ld(DST, 7 + i); b7 = tmp1 + tmp2;
    m0 = ld(DST, 0 + i);
    x4 = ((b6 * 473 - b4 * 196 + 128) >> 8) - b7;
    x0 = x4 - (((tmp1 - tmp2) * 362 + 128) >> 8);
    x1 = m0 - b1; x2 = (((ld(DST, 2 + i) - ld(DST, 6 + i)) * 362 + 128) >> 8) - b3; x3 = m0 + b1;
    y3 = x1 + x2; y4 = x3 + b3; y5 = x1 - x2; y6 = x3 - b3;
    y7 = -x0 - ((b4 * 473 + b6 * 196 + 128) >> 8);
    st(DST, 0 + i, (b7 + y4 + 128) >> 8); st(DST, 1 + i, (x4 + y3 + 128) >> 8);
    st(DST, 2 + i, (y5 - x0 + 128) >> 8); st(DST, 3 + i, (y6 - y7 + 128) >> 8);
    st(DST, 4 + i, (y6 + y7 + 128) >> 8); st(DST, 5 + i, (x0 + y5 + 128) >> 8);
    st(DST, 6 + i, (y3 - x4 + 128) >> 8); st(DST, 7 + i, (y4 - b7 + 128) >> 8);
  }
}
