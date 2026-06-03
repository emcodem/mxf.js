import { describe, it } from 'vitest';
import { statSync, openSync, readSync } from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import { isAnnexB, annexBtoAVCC, extractSPSPPS } from '../src/essence/avc-tools.js';
import { resolveFrameOffset, resolveExactFrameOffset } from '../src/parser/index-table.js';

const FILE = 'C:/temp/mxf.js/xavc_l_1080p50.mxf';

function loader(p: string): any {
  const fd = openSync(p, 'r'); const sz = statSync(p).size;
  return {
    fileSize: Promise.resolve(sz),
    fetchRange: (s: number, e: number) => {
      const n = e - s + 1; const b = Buffer.alloc(n); readSync(fd, b, 0, n, s);
      return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + n));
    },
    destroy() {},
  };
}

async function countFrames(ext: EssenceExtractor, exact: boolean) {
  let video = 0, audio = 0, sps = 0, pps = 0, firstEu = -1;
  for await (const f of ext.fetchFrames(0n, 6, exact)) {
    if (f.trackType === 'audio') { audio++; continue; }
    if (firstEu < 0) firstEu = Number(f.editUnit);
    video++;
    const avcc = isAnnexB(f.data) ? new Uint8Array(annexBtoAVCC(f.data)) : new Uint8Array(f.data);
    const r = extractSPSPPS(avcc.buffer.slice(avcc.byteOffset, avcc.byteOffset + avcc.byteLength));
    sps += r.sps.length; pps += r.pps.length;
    if (video >= 6) break;
  }
  return { exact, video, audio, sps, pps, firstEu };
}

describe('frame0 probe', () => {
  it('resolve + fetch (snapped vs exact)', async () => {
    const bs = await new MxfFile(loader(FILE)).open();
    const { indexSegments, essenceStart, essenceBodySID } = bs as any;
    console.log('essenceStart=', String(essenceStart), 'essenceBodySID=', essenceBodySID, 'segs=', indexSegments.length);
    for (const s of indexSegments) {
      console.log(`  seg bodySID=${s.bodySID} start=${s.indexStartPosition} dur=${s.indexDuration} eubc=${s.editUnitByteCount} entries=${s.entries.length}`);
    }
    console.log('resolveFrameOffset(0) =', JSON.stringify(resolveFrameOffset(indexSegments, 0n, essenceStart, essenceBodySID), (k, v) => typeof v === 'bigint' ? String(v) : v));
    console.log('resolveExactFrameOffset(0) =', JSON.stringify(resolveExactFrameOffset(indexSegments, 0n, essenceStart, essenceBodySID), (k, v) => typeof v === 'bigint' ? String(v) : v));

    console.log('snapped:', JSON.stringify(await countFrames(new EssenceExtractor(loader(FILE), bs), false)));
    console.log('exact:  ', JSON.stringify(await countFrames(new EssenceExtractor(loader(FILE), bs), true)));
  });
});
