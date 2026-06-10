/**
 * Decode the first 120 frames and write raw yuv422p to C:/temp/decoded.yuv
 * Run: npx vitest run scripts/dump-yuv.test.ts
 * View: ffplay -f rawvideo -pix_fmt yuv422p -video_size 1920x1080 -framerate 25 -i C:/temp/decoded.yuv
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import type { EssenceFrame } from '../src/essence/essence-extractor.js';
import { Mpeg2Decoder, type YUVFrame } from '../src/codec/mpeg2-decoder.js';
import { ILoader } from '../src/loader/loader.js';

const FILE = 'C:/dev/mxf.js/media/xdcamhd_1920_25i_16tracks.mxf';
const OUT  = 'C:/temp/decoded.yuv';
const N    = 120;

class FsLoader implements ILoader {
  readonly fileSize: Promise<number>;
  private readonly fd: number;
  constructor(path: string) {
    this.fd = fs.openSync(path, 'r');
    this.fileSize = Promise.resolve(fs.fstatSync(this.fd).size);
  }
  fetchRange(s: number, e: number): Promise<ArrayBuffer> {
    const len = e - s + 1;
    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, s);
    return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  destroy(): void { try { fs.closeSync(this.fd); } catch {} }
}

describe('dump yuv', () => {
  (fs.existsSync(FILE) ? it : it.skip)('decode and write yuv422p', async () => {
    const loader = new FsLoader(FILE);
    const bootstrap = await new MxfFile(loader, false).open();
    const ex = new EssenceExtractor(loader, bootstrap);
    const coded: EssenceFrame[] = [];
    for await (const f of ex.fetchFrames(0n, N + 6, true)) if (f.trackType === 'video') coded.push(f);
    loader.destroy();

    const out = fs.openSync(OUT, 'w');
    let count = 0;

    const dec = new Mpeg2Decoder((f: YUVFrame) => {
      if (count >= N) return;
      // write Y plane (full width × height)
      fs.writeSync(out, Buffer.from(f.y.buffer, f.y.byteOffset, f.y.byteLength));
      // write Cb plane (width/2 × height)
      fs.writeSync(out, Buffer.from(f.cb.buffer, f.cb.byteOffset, f.cb.byteLength));
      // write Cr plane (width/2 × height)
      fs.writeSync(out, Buffer.from(f.cr.buffer, f.cr.byteOffset, f.cr.byteLength));
      count++;
    });

    for (const vf of coded) { dec.write(vf.data); while (dec.decode()) {} }
    dec.flush();
    fs.closeSync(out);

    console.log(`Wrote ${count} frames to ${OUT}`);
    console.log(`ffplay -f rawvideo -pix_fmt yuv422p -video_size 1920x1080 -framerate 25 -i ${OUT}`);
  }, 180_000);
});
