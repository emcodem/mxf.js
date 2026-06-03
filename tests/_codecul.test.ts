import { describe, it } from 'vitest';
import { statSync, openSync, readSync } from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';

function loader(p: string): any {
  const fd = openSync(p, 'r');
  const sz = statSync(p).size;
  return {
    fileSize: Promise.resolve(sz),
    fetchRange: (s: number, e: number) => {
      const n = e - s + 1;
      const b = Buffer.alloc(n);
      readSync(fd, b, 0, n, s);
      return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + n));
    },
    destroy() {},
  };
}

describe('codec UL probe', () => {
  it('prints picture essence coding UL', async () => {
    const bs = await new MxfFile(loader('C:/temp/mxf.js/xavc_l_1080p50.mxf')).open();
    const pd = bs.metadata.pictureDescriptor as any;
    const ul: Uint8Array | null = pd?.pictureEssenceCodingUL ?? null;
    console.log('codec =', pd?.codec);
    console.log('pictureEssenceCodingUL =', ul ? Array.from(ul).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'NULL');
  });
});
