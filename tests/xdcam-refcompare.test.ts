/**
 * Ground-truth comparison: decode the xdcam file with our Mpeg2Decoder and compare
 * each display-order frame against an ffmpeg-decoded yuv422p reference.
 *
 * Guards the 4:2:2 field-DCT chroma organization + sequence-header chroma quant-matrix fixes.
 * Self-skips when the ffmpeg reference is absent (e.g. CI). Prep the reference once:
 *   ffmpeg -y -i media/xdcamhd_1920_25i_16tracks.mxf -frames:v 120 -pix_fmt yuv422p -f rawvideo C:/temp/xdcam_ref422.yuv
 *
 * Run: npx vitest run tests/xdcam-refcompare.test.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import type { EssenceFrame } from '../src/essence/essence-extractor.js';
import { Mpeg2Decoder, type YUVFrame } from '../src/codec/mpeg2-decoder.js';
import { ILoader } from '../src/loader/loader.js';

const FILE = 'C:/dev/mxf.js/media/xdcamhd_1920_25i_16tracks.mxf';
const REF  = 'C:/temp/xdcam_ref422.yuv';
const W = 1920, H = 1080;
const FRAME_BYTES = W * H + 2 * (W / 2) * H; // yuv422p

class FsLoader implements ILoader {
  readonly fileSize: Promise<number>;
  private readonly fd: number;
  constructor(path: string) {
    this.fd = fs.openSync(path, 'r');
    this.fileSize = Promise.resolve(fs.fstatSync(this.fd).size);
  }
  fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    const len = end - start + 1;
    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, start);
    return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  destroy(): void { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
}

function readRefFrame(fd: number, idx: number): { y: Uint8Array; u: Uint8Array; v: Uint8Array } {
  const buf = Buffer.alloc(FRAME_BYTES);
  fs.readSync(fd, buf, 0, FRAME_BYTES, idx * FRAME_BYTES);
  const ySize = W * H, cSize = (W / 2) * H;
  return {
    y: buf.subarray(0, ySize),
    u: buf.subarray(ySize, ySize + cSize),
    v: buf.subarray(ySize + cSize, ySize + 2 * cSize),
  };
}

/** Mean abs error of our plane (cropped to H rows) vs ref plane. */
function planeMAE(ours: Uint8ClampedArray, ourW: number, ourH: number,
                 ref: Uint8Array, refW: number, rows: number): { mae: number; max: number; badPx: number } {
  let sum = 0, max = 0, bad = 0, n = 0;
  const cmpW = Math.min(ourW, refW);
  for (let row = 0; row < rows; row++) {
    const oBase = row * ourW, rBase = row * refW;
    for (let x = 0; x < cmpW; x++) {
      const d = Math.abs(ours[oBase + x] - ref[rBase + x]);
      sum += d; if (d > max) max = d; if (d > 20) bad++; n++;
    }
  }
  return { mae: sum / n, max, badPx: bad };
}

async function collectFrames(start: number, count: number): Promise<EssenceFrame[]> {
  const loader = new FsLoader(FILE);
  const bootstrap = await new MxfFile(loader, false).open();
  const ex = new EssenceExtractor(loader, bootstrap);
  const out: EssenceFrame[] = [];
  for await (const f of ex.fetchFrames(BigInt(start), count, true)) if (f.trackType === 'video') out.push(f);
  loader.destroy();
  return out;
}

describe('xdcam ref compare', () => {
  const ok = fs.existsSync(FILE) && fs.existsSync(REF);
  (ok ? it : it.skip)('per-frame MAE vs ffmpeg', async () => {
    const N = 120;
    const coded = await collectFrames(0, N + 6); // extra for tail B reorder

    const emitted: YUVFrame[] = [];

    const dec = new Mpeg2Decoder((f) => {
      // clone planes — decoder reuses buffers
      emitted.push({ ...f, y: f.y.slice(), cb: f.cb.slice(), cr: f.cr.slice() });
    });
    for (const vf of coded) { dec.write(vf.data); while (dec.decode()) { /* emit */ } }
    dec.flush();

    console.log(`coded AUs=${coded.length} emitted=${emitted.length} ourDim=${emitted[0]?.width}x${emitted[0]?.height}`);

    const refFd = fs.openSync(REF, 'r');
    const refCount = Math.floor(fs.fstatSync(refFd).size / FRAME_BYTES);
    const limit = Math.min(N, emitted.length, refCount);

    const rows: string[] = [];
    // Per-frame plane stats; the first keyframe is surfaced separately as a pure-intra (no motion
    // comp) check, and stats are split by picture type (I/P/B) so a regression localizes quickly.
    type PStat = { mae: number; max: number; badPx: number };
    const PT = ['?', 'I', 'P', 'B'];
    const perFrame: Array<{ i: number; key: boolean; pt: number; yc: PStat; uc: PStat; vc: PStat }> = [];
    let worstFrame = -1, worstMae = 0, worstChromaMae = 0, worstLumaMae = 0, worstMax = 0;
    for (let i = 0; i < limit; i++) {
      const f = emitted[i];
      const ref = readRefFrame(refFd, i);
      const yc = planeMAE(f.y, f.width, f.height, ref.y, W, H);
      const uc = planeMAE(f.cb, f.width / 2, f.height, ref.u, W / 2, H);
      const vc = planeMAE(f.cr, f.width / 2, f.height, ref.v, W / 2, H);
      perFrame.push({ i, key: !!f.isKeyframe, pt: f.pictureType, yc, uc, vc });
      const tot = yc.mae + uc.mae + vc.mae;
      if (tot > worstMae) { worstMae = tot; worstFrame = i; }
      worstChromaMae = Math.max(worstChromaMae, uc.mae, vc.mae);
      worstLumaMae   = Math.max(worstLumaMae, yc.mae);
      worstMax       = Math.max(worstMax, yc.max, uc.max, vc.max);
      const flag = (yc.mae > 0.5 || uc.mae > 0.5 || vc.mae > 0.5) ? '  <== DIFF' : '';
      if (flag || yc.mae > 0.01 || uc.mae > 0.01 || vc.mae > 0.01) {
        rows.push(`f${String(i).padStart(3)} key=${f.isKeyframe?1:0} Y(mae=${yc.mae.toFixed(3)} max=${yc.max} bad=${yc.badPx}) U(mae=${uc.mae.toFixed(3)} max=${uc.max} bad=${uc.badPx}) V(mae=${vc.mae.toFixed(3)} max=${vc.max} bad=${vc.badPx})${flag}`);
      }
    }
    // Log pixel positions of bad pixels for frames with bad > 0,
    // and for those frames also show the I-frame value at same pixel.
    const frame0 = emitted[0];
    const ref0   = readRefFrame(refFd, 0);
    for (let i = 0; i < limit; i++) {
      const f = emitted[i];
      const ref = readRefFrame(refFd, i);
      const cmpW = Math.min(f.width, W);
      const badPixels: string[] = [];
      for (let row = 0; row < H && badPixels.length < 20; row++) {
        for (let x = 0; x < cmpW && badPixels.length < 20; x++) {
          const d = Math.abs(f.y[row * f.width + x] - ref.y[row * W + x]);
          if (d > 20) {
            const iOurs = frame0.y[row * frame0.width + x];
            const iRef  = ref0.y[row * W + x];
            badPixels.push(`(${x},${row}) ours=${f.y[row * f.width + x]} ref=${ref.y[row * W + x]} d=${d}  [I-frame: ours=${iOurs} ref=${iRef}]`);
          }
        }
      }
      if (badPixels.length > 0) {
        console.log(`\nbad pixels in frame ${i}:`);
        badPixels.forEach(p => console.log('  ' + p));
      }
    }
    fs.closeSync(refFd);

    console.log('=== frames with Y/U/V mae > 0.01 vs ffmpeg reference ===');
    if (rows.length === 0) console.log('  (none — bit-exact match)');
    rows.forEach(r => console.log(r));

    // Pure-intra check (first keyframe: no motion comp) + per-picture-type split, so a regression
    // localizes to intra vs P vs B at a glance.
    const fmt = (s: PStat) => `mae=${s.mae.toFixed(4)} max=${s.max} bad=${s.badPx}`;
    const chromaMae = (p: { uc: PStat; vc: PStat }) => Math.max(p.uc.mae, p.vc.mae);
    const firstKey = perFrame.find(p => p.key);
    if (firstKey) console.log(`firstI (f${firstKey.i}) Y(${fmt(firstKey.yc)}) U(${fmt(firstKey.uc)}) V(${fmt(firstKey.vc)})`);
    for (const t of [1, 2, 3]) {
      const ofType = perFrame.filter(p => p.pt === t);
      if (!ofType.length) continue;
      const worstOf = ofType.reduce((a, b) => chromaMae(b) > chromaMae(a) ? b : a);
      const worstY  = ofType.reduce((a, b) => b.yc.mae > a.yc.mae ? b : a);
      console.log(`type ${PT[t]}: n=${ofType.length} worstChromaMae=${chromaMae(worstOf).toFixed(4)} (f${worstOf.i}) worstLumaMae=${worstY.yc.mae.toFixed(4)} (f${worstY.i})`);
    }
    console.log(`worst frame=${worstFrame} totMae=${worstMae.toFixed(4)} worstLumaMae=${worstLumaMae.toFixed(4)} worstChromaMae=${worstChromaMae.toFixed(4)} worstMax=${worstMax}`);
    console.log(`bit-exact status: luma=${worstLumaMae === 0 ? 'EXACT' : `off by ${worstLumaMae.toFixed(4)}`}  chroma=${worstChromaMae === 0 ? 'EXACT' : `off by ${worstChromaMae.toFixed(4)}`}`);

    expect(emitted.length).toBeGreaterThan(50);
    // BIT-EXACT vs the scalar `-cpuflags 0 -flags +bitexact -idct simple` reference. The decoder
    // replicates ff_simple_idct exactly (row DC-only `<<3` shortcut + W4*(c0+32) column rounding),
    // MPEG-2 mismatch control, and the 4:2:2 field-DCT/MC paths. Any non-zero here is a regression.
    expect(worstMax,      'per-pixel max diff must be 0 (bit-exact with ffmpeg)').toBe(0);
    expect(worstChromaMae, 'chroma must be bit-exact with ffmpeg').toBe(0);
    expect(worstLumaMae,   'luma must be bit-exact with ffmpeg').toBe(0);
  }, 180_000);
});
