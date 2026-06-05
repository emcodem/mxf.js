/**
 * Bit-exact parity gate for the WASM IDCT kernel (asm/kernels.ts) against the pure-JS reference
 * (src/codec/mpeg2-decoder.ts `idct`). The WASM kernel is an optimization, never a behaviour change:
 * for every input the two MUST produce identical 64-entry output. Skipped (with a clear message) if
 * the kernel hasn't been built — run `npm run asbuild` first.
 *
 * Inputs are bounded to a realistic premultiplied-coefficient range so intermediates stay within i32
 * (the JS path is float64-then-`>>`-coerced; identical to i32 only while no overflow occurs, which is
 * guaranteed for valid MPEG-2 input — see the kernel header).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { idct as idctJs } from '../src/codec/mpeg2-decoder.js';

const WASM = 'asm/build/kernels.wasm';

let exports: any = null;
beforeAll(async () => {
  if (!fs.existsSync(WASM)) return;
  const bytes = fs.readFileSync(WASM);
  const { instance } = await WebAssembly.instantiate(bytes, { env: { abort() {} } });
  exports = instance.exports;
});

function wasmIdct(src: Int32Array): Int32Array {
  const mem = new Int32Array((exports.memory as WebAssembly.Memory).buffer);
  const srcOff = (exports.idctSrcPtr() as number) >> 2;
  const dstOff = (exports.idctDstPtr() as number) >> 2;
  mem.set(src, srcOff);
  exports.idct();
  return mem.slice(dstOff, dstOff + 64);
}

describe('WASM IDCT parity', () => {
  const ready = fs.existsSync(WASM);
  (ready ? it : it.skip)('matches the JS reference bit-for-bit over many blocks', () => {
    // Deterministic LCG so failures reproduce.
    let s = 0x12345678 >>> 0;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s; };

    const cases: Int32Array[] = [];
    // DC-only, single-AC, and full random blocks across the realistic bounded range.
    for (let k = 0; k < 2000; k++) {
      const b = new Int32Array(64);
      const mode = k % 4;
      if (mode === 0) { b[0] = (rnd() % 262144) - 131072; }                    // DC only
      else if (mode === 1) { b[0] = (rnd() % 4096) - 2048; b[1 + (rnd() % 10)] = (rnd() % 4096) - 2048; }
      else { const nz = 1 + (rnd() % 20); for (let j = 0; j < nz; j++) b[rnd() % 64] = (rnd() % 262144) - 131072; }
      cases.push(b);
    }

    for (let i = 0; i < cases.length; i++) {
      const src = cases[i];
      const jsDst = new Int32Array(64);
      idctJs(src.slice(), jsDst);
      const wDst = wasmIdct(src);
      // Compare
      let mismatch = -1;
      for (let j = 0; j < 64; j++) if (jsDst[j] !== wDst[j]) { mismatch = j; break; }
      if (mismatch >= 0) {
        throw new Error(`case ${i} idx ${mismatch}: js=${jsDst[mismatch]} wasm=${wDst[mismatch]}\n src=[${Array.from(src)}]`);
      }
    }
    expect(true).toBe(true);
  });
});
