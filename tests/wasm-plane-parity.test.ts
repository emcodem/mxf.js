/**
 * Validates the "planes backed by WASM memory" refactor (no kernels yet — same JS ops, different
 * backing store). Decodes real frames with the pure-JS plane path AND with the WASM-arena plane
 * path and asserts the decoded output is byte-identical. Skipped if the WASM kernel isn't built
 * (`npm run asbuild`) or the sample file is absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { ILoader } from '../src/loader/loader.js';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import { Mpeg2Decoder } from '../src/codec/mpeg2-decoder.js';
import { ensureKernels, __resetKernelsForTest } from '../src/codec/wasm/kernels.js';

class FsLoader implements ILoader {
  readonly fileSize: Promise<number>;
  private readonly fd: number;
  constructor(path: string) { this.fd = fs.openSync(path, 'r'); this.fileSize = Promise.resolve(fs.fstatSync(this.fd).size); }
  fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    const len = end - start + 1; const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, start);
    return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  destroy(): void { try { fs.closeSync(this.fd); } catch {} }
}

const FILE = 'C:/temp/mxf.js/XDCAMHD_Choppy.mxf';
const WASM = 'asm/build/kernels.wasm';

function hashInto(h: number, a: Uint8ClampedArray): number {
  for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

async function decodeHash(frames: ArrayBuffer[]): Promise<number> {
  let hash = 0x811c9dc5;
  const dec = new Mpeg2Decoder((fr) => { hash = hashInto(hash, fr.y); hash = hashInto(hash, fr.cb); hash = hashInto(hash, fr.cr); });
  for (const f of frames) { dec.write(f); while (dec.decode()) {} }
  dec.flush();
  return hash >>> 0;
}

describe('WASM-arena plane parity', () => {
  const ready = fs.existsSync(FILE) && fs.existsSync(WASM);
  (ready ? it : it.skip)('JS-array planes and WASM-arena planes decode identically', async () => {
    const loader = new FsLoader(FILE);
    const b = await new MxfFile(loader, false).open();
    const frames: ArrayBuffer[] = [];
    // 300 frames so the run crosses the macroblock writes that address past the plane end (which the
    // WASM kernel must drop exactly like JS — a regression here previously trapped "memory access out
    // of bounds" around frame ~249 once the current plane rotated into the last arena slot).
    for await (const f of new EssenceExtractor(loader, b).fetchFrames(0n, 300, true)) {
      if (f.trackType === 'video') frames.push(f.data);
    }
    loader.destroy();

    // JS path (kernels not loaded).
    __resetKernelsForTest();
    const hashJs = await decodeHash(frames);

    // WASM-arena path (planes are views over WASM memory; ops still in JS).
    const k = await ensureKernels(fs.readFileSync(WASM));
    expect(k, 'kernels should instantiate').not.toBeNull();
    const hashWasm = await decodeHash(frames);

    console.log(`hashJs=0x${hashJs.toString(16)} hashWasm=0x${hashWasm.toString(16)}`);
    expect(hashWasm).toBe(hashJs);
    __resetKernelsForTest();
  }, 60000);
});
