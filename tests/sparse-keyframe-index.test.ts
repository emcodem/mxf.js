import { describe, it, expect } from 'vitest';
import { SparseKeyframeIndex } from '../src/essence/sparse-keyframe-index.js';

describe('SparseKeyframeIndex', () => {
  it('floor() returns the nearest recorded keyframe at or below the target', () => {
    const idx = new SparseKeyframeIndex();
    idx.record(0n, 1000n);
    idx.record(12n, 5000n);
    idx.record(24n, 9000n);

    expect(idx.floor(5n)).toEqual({ editUnit: 0n, byteOffset: 1000n });
    expect(idx.floor(12n)).toEqual({ editUnit: 12n, byteOffset: 5000n });
    expect(idx.floor(30n)).toEqual({ editUnit: 24n, byteOffset: 9000n });
  });

  it('returns null below the first recorded keyframe', () => {
    const idx = new SparseKeyframeIndex();
    idx.record(10n, 100n);
    expect(idx.floor(5n)).toBeNull();
  });

  it('ignores non-forward (re-scanned / duplicate) edit units', () => {
    const idx = new SparseKeyframeIndex();
    idx.record(0n, 0n);
    idx.record(12n, 100n);
    idx.record(12n, 999n);  // duplicate — ignored
    idx.record(6n, 50n);    // backward — ignored
    expect(idx.size).toBe(2);
    expect(idx.floor(12n)!.byteOffset).toBe(100n);
  });

  it('stays bounded by decimating when it exceeds maxEntries, preserving floor coverage', () => {
    const idx = new SparseKeyframeIndex(16);
    for (let i = 0; i < 1000; i++) idx.record(BigInt(i * 12), BigInt(i * 100000));
    expect(idx.size).toBeLessThanOrEqual(16);
    // Coverage is sparse but a floor lookup still lands on a real, earlier keyframe.
    const f = idx.floor(6000n);
    expect(f).not.toBeNull();
    expect(f!.editUnit).toBeLessThanOrEqual(6000n);
    expect(f!.editUnit % 12n).toBe(0n);
  });

  it('clear() empties the map and resets the stride', () => {
    const idx = new SparseKeyframeIndex(16);
    for (let i = 0; i < 100; i++) idx.record(BigInt(i * 12), BigInt(i));
    idx.clear();
    expect(idx.size).toBe(0);
    idx.record(0n, 0n);
    idx.record(12n, 1n);
    expect(idx.size).toBe(2); // stride reset → consecutive records accepted again
  });
});
