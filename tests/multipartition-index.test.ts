/**
 * Regression test for the second-half scrub freeze on multi-partition MPEG-2 Long-GOP files.
 *
 * `PAT05732.mxf` is a 3.5 GB OP1a clip whose essence spans 3 body partitions, each carrying its own
 * incremental index table (~166 KB) with GLOBAL edit-unit numbering (0–14999, 15000–29999,
 * 30000–42000). collectMultiPartitionIndex previously read only a 64 KB window per partition, so
 * partitions 2 & 3 (index region + first essence element both past 64 KB) contributed nothing →
 * `indexSegments` covered EU 0–14999 only → scrubbing past EU 15000 resolved no keyframe → freeze.
 *
 * The fix reads each oversized index segment at its own self-describing KLV length. This test asserts
 * the index now tiles the whole file and that a keyframe deep in partition 3 resolves to a byte
 * offset inside that partition. Skipped if the real file is absent.
 *
 * Run: npx vitest run tests/multipartition-index.test.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MxfFile } from '../src/mxf-file.js';
import { resolveLongGopKeyframe } from '../src/parser/index-table.js';
import { ILoader } from '../src/loader/loader.js';

const FILE = process.env.TEST_MULTIPART_FILE ?? 'C:/temp/mxf.js/Omneon_mpeg2_420_oddbodies.mxf';

// First essence element of each body partition (from the TODO probe). A keyframe resolved within a
// partition's edit-unit range must point at a byte offset inside that partition.
const PARTITION1_ESSENCE_START = 184_459;
const PARTITION2_ESSENCE_START = 1_269_653_635;
const PARTITION3_ESSENCE_START = 2_539_395_384;

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

describe('multi-partition Long-GOP index coverage', () => {
  const exists = fs.existsSync(FILE);
  (exists ? it : it.skip)('index tiles the whole file and partition-3 keyframes resolve', async () => {
    const loader = new FsLoader(FILE);
    const bootstrap = await new MxfFile(loader, true).open();

    // Highest edit unit any segment covers — must reach into the last partition (~42001), not stop
    // at partition 1's 15000.
    const maxCovered = bootstrap.indexSegments.reduce(
      (m, s) => { const end = s.indexStartPosition + s.indexDuration; return end > m ? end : m; },
      0n,
    );
    console.log(`[multipart] indexMode=${bootstrap.indexMode} segs=${bootstrap.indexSegments.length} maxCovered=${maxCovered}`);
    expect(maxCovered).toBeGreaterThan(40_000n);

    // A keyframe resolved inside each partition's edit-unit range must land in that partition's byte
    // range — verifying the cross-partition streamOffset remap (and the identity base for partition 1,
    // whose essence lives in the header partition at file offset 0).
    const resolveAt = (eu: number) => {
      const kf = resolveLongGopKeyframe(
        bootstrap.indexSegments, BigInt(eu), bootstrap.essenceStart, bootstrap.essenceBodySID);
      console.log(`[multipart] resolveLongGopKeyframe(${eu}) → ${kf ? `EU ${kf.nearestKeyframeEditUnit} @ ${kf.byteOffset}` : 'null'}`);
      return kf;
    };

    const kf1 = resolveAt(5_000);   // partition 1 (header-partition essence, identity base)
    const kf2 = resolveAt(20_000);  // partition 2
    const kf3 = resolveAt(30_000);  // partition 3 boundary

    loader.destroy();

    // Partition 1 — was already correct, must STAY correct (the identity base, not remapped away).
    expect(kf1, 'a keyframe at EU 5000 must resolve').not.toBeNull();
    expect(Number(kf1!.byteOffset)).toBeGreaterThanOrEqual(PARTITION1_ESSENCE_START);
    expect(Number(kf1!.byteOffset)).toBeLessThan(PARTITION2_ESSENCE_START);

    // Partition 2 — the previously-dropped middle partition.
    expect(kf2, 'a keyframe at EU 20000 must resolve (was null → freeze)').not.toBeNull();
    expect(Number(kf2!.byteOffset)).toBeGreaterThanOrEqual(PARTITION2_ESSENCE_START);
    expect(Number(kf2!.byteOffset)).toBeLessThan(PARTITION3_ESSENCE_START);

    // Partition 3 — deepest; must snap to a nearby keyframe and land in partition 3.
    expect(kf3, 'a keyframe at EU 30000 must resolve (was null → freeze)').not.toBeNull();
    expect(Number(kf3!.nearestKeyframeEditUnit)).toBeGreaterThan(29_000);
    expect(Number(kf3!.nearestKeyframeEditUnit)).toBeLessThanOrEqual(30_000);
    expect(Number(kf3!.byteOffset)).toBeGreaterThanOrEqual(PARTITION3_ESSENCE_START);
  }, 120_000);
});
