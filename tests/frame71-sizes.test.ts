import { it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MxfFile } from '../src/mxf-file.js';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import type { ILoader } from '../src/loader/loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  destroy(): void { try { fs.closeSync(this.fd); } catch { } }
}

it('frame sizes around 71', async () => {
  const FILE = process.env.TEST_MXF_FILE ?? path.resolve(__dirname, '../media/xdcamhd_1920_25i_16tracks.mxf');
  if (!fs.existsSync(FILE)) { console.log(`skip: ${FILE} not found`); return; }
  const loader = new FsLoader(FILE);
  const bootstrap = await new MxfFile(loader, false).open();
  const ex = new EssenceExtractor(loader, bootstrap);
  let idx = 0;
  for await (const f of ex.fetchFrames(0n, 78, true)) {
    if (f.trackType === 'video' && idx >= 65 && idx <= 77) {
      const d = new Uint8Array(f.data);
      console.log(`frame ${idx}: size=${f.data.byteLength} start=${d.slice(0,4).join(',')}`);
    }
    if (f.trackType === 'video') idx++;
  }
  loader.destroy();
}, 30000);
