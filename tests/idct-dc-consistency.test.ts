/**
 * Self-consistency of the DC-only IDCT fast path.
 *
 * For a block whose only non-zero coefficient is the DC term [0][0], the decoder skips the full
 * 8x8 idct() and uses dcOnlyPixel() to fill all 64 positions (see mpeg2-decoder.ts: the n===1
 * branch in decodeBlock). Chroma is smoother than luma, so DC-only blocks are disproportionately
 * chroma — meaning any divergence between dcOnlyPixel() and the real idct() would surface mostly
 * as a chroma error. This pure test (no media, CI-safe) asserts they agree exactly over the full
 * intra-DC range, so the chroma-error hunt can either rule dcOnlyPixel out or pin a bug on it.
 *
 * Run: npx vitest run tests/idct-dc-consistency.test.ts
 */
import { describe, it, expect } from 'vitest';
import { idct, dcOnlyPixel } from '../src/codec/mpeg2-decoder.js';

describe('dcOnlyPixel vs full idct (DC-only block)', () => {
  it('all 64 output pixels equal dcOnlyPixel(dc) for the full intra-DC range', () => {
    const src = new Int32Array(64);
    const dst = new Int32Array(64);
    // Intra DC after `<< (3 - intraDcPrecision)` reaches ~±2046 at precision 2; sweep wider as a
    // safety margin and to exercise negative-value signed `>>`.
    const mismatches: string[] = [];
    for (let dc = -4096; dc <= 4096; dc++) {
      const expected = dcOnlyPixel(dc);
      src.fill(0);
      src[0] = dc;
      dst.fill(0);
      idct(src, dst);
      for (let i = 0; i < 64; i++) {
        if (dst[i] !== expected) {
          mismatches.push(`dc=${dc} pos=${i}: idct=${dst[i]} dcOnlyPixel=${expected}`);
          if (mismatches.length >= 20) break;
        }
      }
      if (mismatches.length >= 20) break;
    }
    expect(mismatches, mismatches.slice(0, 20).join('\n')).toEqual([]);
  });
});
