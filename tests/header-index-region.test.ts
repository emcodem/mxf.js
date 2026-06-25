/**
 * Regression test for the "first second loops forever" bug on AVC-Intra OP1a files whose CBG index
 * segment lives in the HEADER partition's own index region.
 *
 * `1080i25_ARDZDF_HDF02a_AVC-I-100.mxf` (370 MB, 25 s) declares hdrBC=2_000_000, idxBC=192,
 * indexSID=2 — the single CBG index segment (editUnitByteCount=615209, bodySID=1) sits at
 * `afterPP + headerByteCount` = 2_000_156, exactly where the header-metadata read ends, and a RIP
 * body entry (bodySID=1 @2_000_348) sends locateEssence's walk PAST it. So `indexSegments` came back
 * empty → classifyIndexMode 'none' → the sequential reader re-read from the essence start on every
 * forward fetch while stamping advancing timestamps, so playback looped the first second (with the
 * correct 25 s duration and a working seek bar).
 *
 * The fix reads the header partition's declared index region explicitly. This test asserts the index
 * is now found (indexMode 'cbg') and that consecutive frames resolve to distinct, stride-spaced byte
 * offsets. Skipped if the real file is absent.
 *
 * Run: $env:TEST_HEADER_INDEX_FILE="C:/Temp/mxf.js/1080i25_ARDZDF_HDF02a_AVC-I-100.mxf"; npx vitest run tests/header-index-region.test.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { resolveFrameOffset } from '../src/parser/index-table.js';
import { ILoader } from '../src/loader/loader.js';

const FILE = process.env.TEST_HEADER_INDEX_FILE
  ?? 'C:/Temp/mxf.js/1080i25_ARDZDF_HDF02a_AVC-I-100.mxf';

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

describe('header-partition index region (CBG after headerByteCount)', () => {
  const exists = fs.existsSync(FILE);
  (exists ? it : it.skip)('collects the CBG index → indexMode cbg, distinct per-frame offsets', async () => {
    const loader = new FsLoader(FILE);
    const bootstrap = await new MxfFile(loader, true).open();

    // The bug left indexSegments empty → 'none'. With the fix the header index region is read.
    expect(bootstrap.indexMode).toBe('cbg');

    const cbg = bootstrap.indexSegments.find(s => s.editUnitByteCount > 0);
    expect(cbg).toBeDefined();
    expect(cbg!.editUnitByteCount).toBe(615209);

    // Frame N must resolve to essenceStart + N*editUnitByteCount — NOT all to the same byte (the
    // 'none' fallback re-read frame 0's bytes for every fetch).
    const vid = bootstrap.essenceBodySID;
    const f0 = resolveFrameOffset(bootstrap.indexSegments, 0n, bootstrap.essenceStart, vid);
    const f1 = resolveFrameOffset(bootstrap.indexSegments, 1n, bootstrap.essenceStart, vid);
    const f10 = resolveFrameOffset(bootstrap.indexSegments, 10n, bootstrap.essenceStart, vid);
    expect(f0).not.toBeNull();
    expect(f1!.byteOffset - f0!.byteOffset).toBe(615209n);
    expect(f10!.byteOffset - f0!.byteOffset).toBe(6_152_090n);
  });
});
