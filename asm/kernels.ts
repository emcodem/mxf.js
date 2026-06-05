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

/**
 * Two-pass row/column inverse DCT, scalar. Reads 64 i32 from SRC, writes 64 i32 to DST.
 * Mirrors `idct(src, dst)` in src/codec/mpeg2-decoder.ts exactly: same constants (473, 196, 362),
 * same `>> 8` rounding with `+128`, same dataflow. i32 wraps like JS `>>`-coerced arithmetic, and
 * the inputs are ranged (jsmpeg-derived) so intermediates stay within i32 — so the result is
 * identical to the JS float64-then-ToInt32 path.
 */
function idctCore(): void {
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
