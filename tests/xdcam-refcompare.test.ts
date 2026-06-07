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
    let worstFrame = -1, worstMae = 0, worstChromaMae = 0;
    for (let i = 0; i < limit; i++) {
      const f = emitted[i];
      const ref = readRefFrame(refFd, i);
      const yc = planeMAE(f.y, f.width, f.height, ref.y, W, H);
      const uc = planeMAE(f.cb, f.width / 2, f.height, ref.u, W / 2, H);
      const vc = planeMAE(f.cr, f.width / 2, f.height, ref.v, W / 2, H);
      const tot = yc.mae + uc.mae + vc.mae;
      if (tot > worstMae) { worstMae = tot; worstFrame = i; }
      worstChromaMae = Math.max(worstChromaMae, uc.mae, vc.mae);
      const flag = (yc.mae > 1 || uc.mae > 1 || vc.mae > 1) ? '  <== DIFF' : '';
      if (flag || i === 56 || i === 82 || i === 104) {
        rows.push(`f${String(i).padStart(3)} key=${f.isKeyframe?1:0} Y(mae=${yc.mae.toFixed(2)} max=${yc.max} bad=${yc.badPx}) U(mae=${uc.mae.toFixed(2)} max=${uc.max} bad=${uc.badPx}) V(mae=${vc.mae.toFixed(2)} max=${vc.max} bad=${vc.badPx})${flag}`);
      }
    }
    fs.closeSync(refFd);

    console.log('=== frames flagged (mae>1) + error TCs 56/82/104 ===');
    rows.forEach(r => console.log(r));
    console.log(`worst frame=${worstFrame} totMae=${worstMae.toFixed(2)} worstChromaMae=${worstChromaMae.toFixed(2)}`);

    // Before the 4:2:2 field-DCT chroma fix the worst chroma MAE was ~4.3 (frame 86, an I-frame);
    // a correct decode tracks ffmpeg to within rounding (<0.5). Luma was always near-perfect.
    expect(emitted.length).toBeGreaterThan(50);
    expect(worstChromaMae, 'chroma diverges from ffmpeg — 4:2:2 field-DCT/quant-matrix regression').toBeLessThan(0.6);
  }, 180_000);
});
