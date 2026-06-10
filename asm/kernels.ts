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
const SRC: usize = memory.data(64 * 4, 16);
const DST: usize = memory.data(64 * 4, 16);

export function idctSrcPtr(): i32 { return SRC as i32; }
export function idctDstPtr(): i32 { return DST as i32; }

// ── Plane arena ──────────────────────────────────────────────────────────────
// Three frame slots (current / forward / backward), each Y + Cr + Cb, sized for the largest MPEG-2
// frame this path handles — XDCAM HD: 1920×1088, 4:2:2. The JS decoder allocates plane buffers as
// views over these fixed regions (so the WASM kernels can read/write them with no per-block boundary
// copy); a larger frame falls back to plain JS arrays. The arena lives after static data and is
// covered by a single memory.grow() at load (ensureMemory), BEFORE any view is created — so the
// one-time grow can't detach a live view, and no further growth ever happens.
const MAX_Y: i32 = 1920 * 1088;          // 2,088,960 bytes (luma)
const MAX_C: i32 = (1920 * 1088) >> 1;   // 1,044,480 bytes (4:2:2 chroma; ≥ the 4:2:0 case)
const SLOT: i32 = MAX_Y + 2 * MAX_C;     // bytes per frame slot
// Reserve the whole arena as uninitialized static memory. AS sizes the module's initial memory to
// cover it (no data bytes emitted into the binary, so the .wasm stays tiny), and memory never grows
// at runtime — so the JS views over memory.buffer are created once and can never be detached.
const ARENA: usize = memory.data(3 * SLOT, 16);

export function maxYBytes(): i32 { return MAX_Y; }
export function maxCBytes(): i32 { return MAX_C; }

// @ts-ignore: decorator
@inline function slotBase(s: i32): usize { return ARENA + <usize>(s * SLOT); }
/** Plane base pointers for slot s ∈ {0:current, 1:forward, 2:backward}. */
export function planeYPtr(s: i32): i32 { return slotBase(s) as i32; }
export function planeCrPtr(s: i32): i32 { return (slotBase(s) + <usize>MAX_Y) as i32; }
export function planeCbPtr(s: i32): i32 { return (slotBase(s) + <usize>(MAX_Y + MAX_C)) as i32; }

// @ts-ignore: decorator
@inline function ld(base: usize, i: i32): i32 { return load<i32>(base + (<usize>i << 2)); }
// @ts-ignore: decorator
@inline function st(base: usize, i: i32, v: i32): void { store<i32>(base + (<usize>i << 2), v); }

// W constants matching ff_simple_idct_int16_8bit (libavcodec/simple_idct_template.c, BIT_DEPTH==8).
const W1: i32 = 22725, W2: i32 = 21407, W3: i32 = 19266, W4: i32 = 16383;
const W5: i32 = 12873, W6: i32 =  8867, W7: i32 =  4520;
const ROW_SHIFT: i32 = 11, ROW_ROUND: i32 = 1 << (ROW_SHIFT - 1); // 1024
// ff_simple_idct folds the column rounding into the DC term as W4*(c0 + COL_DC_BIAS), where
// COL_DC_BIAS = (1<<(COL_SHIFT-1))/W4 = 32 → W4*32 = 524256 (NOT the exact 524288). Matching this
// is required for bit-exactness with `-idct simple`. DC_SHIFT=3 is the row DC-only broadcast scale.
const COL_SHIFT: i32 = 20, COL_DC_BIAS: i32 = 32, DC_SHIFT: i32 = 3;

/**
 * Two-pass 8×8 IDCT matching ff_simple_idct_int16_8bit. Reads 64 i32 from SRC (raw dequantized
 * coefficients), writes 64 i32 pixel residuals to DST. i32 mul/shr_s wrap identically to JS's
 * ToInt32+>> on the same values, so JS and WASM remain bit-exact.
 */
function idctCore(): void {
  // Row pass: 1D IDCT across each of 8 rows (read SRC, write DST).
  for (let r: i32 = 0; r < 8; r++) {
    const base: i32 = r * 8;
    const r0: i32 = ld(SRC, base), r1: i32 = ld(SRC, base+1), r2: i32 = ld(SRC, base+2), r3: i32 = ld(SRC, base+3);
    const r4: i32 = ld(SRC, base+4), r5: i32 = ld(SRC, base+5), r6: i32 = ld(SRC, base+6), r7: i32 = ld(SRC, base+7);

    // ff_simple_idct row DC-only shortcut: AC-zero row broadcasts (row[0]<<3) truncated to int16.
    if ((r1 | r2 | r3 | r4 | r5 | r6 | r7) == 0) {
      const dc: i32 = ((r0 << DC_SHIFT) << 16) >> 16;
      st(DST, base, dc); st(DST, base+1, dc); st(DST, base+2, dc); st(DST, base+3, dc);
      st(DST, base+4, dc); st(DST, base+5, dc); st(DST, base+6, dc); st(DST, base+7, dc);
      continue;
    }

    let a0: i32 = W4 * r0 + ROW_ROUND;
    let a1: i32 = a0, a2: i32 = a0, a3: i32 = a0;
    a0 += W2 * r2; a1 += W6 * r2; a2 -= W6 * r2; a3 -= W2 * r2;

    let b0: i32 = W1 * r1 + W3 * r3;
    let b1: i32 = W3 * r1 - W7 * r3;
    let b2: i32 = W5 * r1 - W1 * r3;
    let b3: i32 = W7 * r1 - W5 * r3;

    if ((r4 | r5 | r6 | r7) != 0) {
      a0 += W4 * r4 + W6 * r6; a1 -= W4 * r4 + W2 * r6;
      a2 -= W4 * r4 - W2 * r6; a3 += W4 * r4 - W6 * r6;
      b0 += W5 * r5 + W7 * r7; b1 -= W1 * r5 + W5 * r7;
      b2 += W7 * r5 + W3 * r7; b3 += W3 * r5 - W1 * r7;
    }

    st(DST, base,   (a0 + b0) >> ROW_SHIFT); st(DST, base+7, (a0 - b0) >> ROW_SHIFT);
    st(DST, base+1, (a1 + b1) >> ROW_SHIFT); st(DST, base+6, (a1 - b1) >> ROW_SHIFT);
    st(DST, base+2, (a2 + b2) >> ROW_SHIFT); st(DST, base+5, (a2 - b2) >> ROW_SHIFT);
    st(DST, base+3, (a3 + b3) >> ROW_SHIFT); st(DST, base+4, (a3 - b3) >> ROW_SHIFT);
  }

  // Column pass: 1D IDCT down each of 8 columns, in-place on DST.
  for (let c: i32 = 0; c < 8; c++) {
    const c0: i32 = ld(DST, c), c8: i32 = ld(DST, c+8), c16: i32 = ld(DST, c+16), c24: i32 = ld(DST, c+24);
    const c32: i32 = ld(DST, c+32), c40: i32 = ld(DST, c+40), c48: i32 = ld(DST, c+48), c56: i32 = ld(DST, c+56);

    let a0: i32 = W4 * (c0 + COL_DC_BIAS);   // ff_simple_idct folds COL rounding into the DC term
    let a1: i32 = a0, a2: i32 = a0, a3: i32 = a0;
    a0 += W2 * c16; a1 += W6 * c16; a2 -= W6 * c16; a3 -= W2 * c16;

    let b0: i32 = W1 * c8 + W3 * c24;
    let b1: i32 = W3 * c8 - W7 * c24;
    let b2: i32 = W5 * c8 - W1 * c24;
    let b3: i32 = W7 * c8 - W5 * c24;

    if (c32 != 0) { a0 += W4 * c32; a1 -= W4 * c32; a2 -= W4 * c32; a3 += W4 * c32; }
    if (c40 != 0) { b0 += W5 * c40; b1 -= W1 * c40; b2 += W7 * c40; b3 += W3 * c40; }
    if (c48 != 0) { a0 += W6 * c48; a1 -= W2 * c48; a2 += W2 * c48; a3 -= W6 * c48; }
    if (c56 != 0) { b0 += W7 * c56; b1 -= W5 * c56; b2 += W3 * c56; b3 -= W1 * c56; }

    st(DST, c,    (a0 + b0) >> COL_SHIFT); st(DST, c+8,  (a1 + b1) >> COL_SHIFT);
    st(DST, c+16, (a2 + b2) >> COL_SHIFT); st(DST, c+24, (a3 + b3) >> COL_SHIFT);
    st(DST, c+32, (a3 - b3) >> COL_SHIFT); st(DST, c+40, (a2 - b2) >> COL_SHIFT);
    st(DST, c+48, (a1 - b1) >> COL_SHIFT); st(DST, c+56, (a0 - b0) >> COL_SHIFT);
  }
}

/** Standalone IDCT (SRC → DST), kept for the bit-exact parity test against the JS reference. */
export function idct(): void { idctCore(); }

// @ts-ignore: decorator
@inline function clamp8(v: i32): u8 { return v < 0 ? 0 : (v > 255 ? 255 : <u8>v); }

/**
 * IDCT the coefficients in SRC, then write the 8×8 residual into the plane at byte offset `index`
 * (relative to `planePtr`), 8 px/row advancing by `scan + 8` — mirroring copyBlock (intra) / addBlock
 * (inter) in src/codec/mpeg2-decoder.ts, with Uint8ClampedArray semantics via clamp8.
 */
// `planeLen` is the plane's element length (codedSize / chromaSize). The decoder occasionally
// addresses a residual write past the plane end (MB-aligned coded dims / field-DCT edge blocks); the
// JS path drops those silently (a Uint8ClampedArray store at index ≥ length is a no-op), so we guard
// every element the same way — bit-identical to JS, and it keeps raw WASM stores inside the arena.
export function idctAddBlock(planePtr: i32, index: i32, scan: i32, intra: i32, planeLen: i32): void {
  idctCore();
  let di: i32 = index;
  let n: i32 = 0;
  if (intra != 0) {
    for (let row = 0; row < 8; row++) {
      for (let c = 0; c < 8; c++) { const e = di + c; if (e >= 0 && e < planeLen) store<u8>(<usize>(planePtr + e), clamp8(ld(DST, n + c))); }
      n += 8; di += scan + 8;
    }
  } else {
    for (let row = 0; row < 8; row++) {
      for (let c = 0; c < 8; c++) {
        const e = di + c;
        if (e >= 0 && e < planeLen) { const a: usize = <usize>(planePtr + e); store<u8>(a, clamp8(<i32>load<u8>(a) + ld(DST, n + c))); }
      }
      n += 8; di += scan + 8;
    }
  }
}

/**
 * DC-only fast path (the JS `n === 1` branch): fill (intra) / add (inter) a constant 8×8 block.
 * `dc` is the JS-computed value `(blockData[0] + 128) >> 8`. Mirrors copyValue / addValue.
 */
export function dcBlock(planePtr: i32, index: i32, scan: i32, intra: i32, dc: i32, planeLen: i32): void {
  let di: i32 = index;
  if (intra != 0) {
    const v: u8 = clamp8(dc);
    for (let row = 0; row < 8; row++) {
      for (let c = 0; c < 8; c++) { const e = di + c; if (e >= 0 && e < planeLen) store<u8>(<usize>(planePtr + e), v); }
      di += scan + 8;
    }
  } else {
    for (let row = 0; row < 8; row++) {
      for (let c = 0; c < 8; c++) {
        const e = di + c;
        if (e >= 0 && e < planeLen) { const a: usize = <usize>(planePtr + e); store<u8>(a, clamp8(<i32>load<u8>(a) + dc)); }
      }
      di += scan + 8;
    }
  }
}
