import { describe, it, expect } from 'vitest';
import {
  parseIndexTableSegment, resolveFrameOffset, resolveExactFrameOffset, gopLengthFromKeyframe,
  findCbgSegment, resolveCbgFrameOffset, classifyIndexMode,
  segUsesPredictionFlags, isKeyframeEntry, resolveEntryMeta,
  findKeyframeFloor, findKeyframeCeil, longGopGopLength, resolveLongGopKeyframe,
} from '../src/parser/index-table.js';
import type { IndexTableSegment, IndexEntry } from '../src/parser/index-table.js';

/** Build an IndexTableSegment with sensible defaults; override per-test. */
function makeSegment(opts: Partial<IndexTableSegment> = {}): IndexTableSegment {
  return {
    indexStartPosition: 0n,
    indexDuration: 0n,
    editUnitByteCount: 0,
    indexSID: 0,
    bodySID: 0,
    sliceCount: 0,
    posTableCount: 0,
    entries: [],
    ...opts,
  };
}
import { readKLV } from '../src/core/klv.js';
import { UL_INDEX_TABLE_SEGMENT_V1 } from '../src/core/ul.js';
import { encodeBerLength } from '../src/core/ber.js';

function buildIndexTableSegmentBuffer(entries: { streamOffset: bigint; isKeyframe: boolean }[]): ArrayBuffer {
  function tag16(tag: number, ...bytes: number[]): Uint8Array {
    const data = new Uint8Array(bytes);
    const out = new Uint8Array(4 + data.length);
    const v = new DataView(out.buffer);
    v.setUint16(0, tag, false);
    v.setUint16(2, data.length, false);
    out.set(data, 4);
    return out;
  }
  function tag64(tag: number, val: bigint): Uint8Array {
    const out = new Uint8Array(12);
    const v = new DataView(out.buffer);
    v.setUint16(0, tag, false);
    v.setUint16(2, 8, false);
    v.setUint32(4, Number(val >> 32n) >>> 0, false);
    v.setUint32(8, Number(val & 0xffffffffn) >>> 0, false);
    return out;
  }
  function tag32(tag: number, val: number): Uint8Array {
    const out = new Uint8Array(8);
    const v = new DataView(out.buffer);
    v.setUint16(0, tag, false);
    v.setUint16(2, 4, false);
    v.setUint32(4, val, false);
    return out;
  }

  const entryItemLen = 11;
  const count = entries.length;
  const entryArrayData = new Uint8Array(8 + count * entryItemLen);
  const eav = new DataView(entryArrayData.buffer);
  eav.setUint32(0, count, false);
  eav.setUint32(4, entryItemLen, false);
  for (let i = 0; i < count; i++) {
    const base = 8 + i * entryItemLen;
    eav.setInt8(base, 0);
    eav.setInt8(base + 1, 0);
    const flags = entries[i].isKeyframe ? 0x00 : 0x01;
    eav.setUint8(base + 2, flags);
    const off = entries[i].streamOffset;
    eav.setUint32(base + 3, Number(off >> 32n) >>> 0, false);
    eav.setUint32(base + 7, Number(off & 0xffffffffn) >>> 0, false);
  }

  const entryTag = new Uint8Array(4 + entryArrayData.length);
  const etv = new DataView(entryTag.buffer);
  etv.setUint16(0, 0x3f0a, false);
  etv.setUint16(2, entryArrayData.length, false);
  entryTag.set(entryArrayData, 4);

  const parts: Uint8Array[] = [
    tag64(0x3f0c, 0n),
    tag64(0x3f0d, BigInt(count)),
    tag32(0x3f05, 0),
    tag32(0x3f06, 1),
    tag32(0x3f07, 1),
    tag16(0x3f08, 0),
    tag16(0x3f0b, 0),
    entryTag,
  ];

  const totalValueLen = parts.reduce((s, p) => s + p.length, 0);
  const berLen = encodeBerLength(totalValueLen);
  const totalBufLen = 16 + berLen.length + totalValueLen;
  const buf = new Uint8Array(totalBufLen);
  buf.set(UL_INDEX_TABLE_SEGMENT_V1, 0);
  buf.set(berLen, 16);
  let offset = 16 + berLen.length;
  for (const p of parts) { buf.set(p, offset); offset += p.length; }
  return buf.buffer;
}

describe('parseIndexTableSegment', () => {
  it('parses variable-length index with 3 entries', () => {
    const buffer = buildIndexTableSegmentBuffer([
      { streamOffset: 0n,      isKeyframe: true  },
      { streamOffset: 100000n, isKeyframe: false },
      { streamOffset: 200000n, isKeyframe: false },
    ]);
    const klv = readKLV(buffer, 0);
    const seg = parseIndexTableSegment(buffer, klv);

    expect(seg.indexStartPosition).toBe(0n);
    expect(seg.indexDuration).toBe(3n);
    expect(seg.editUnitByteCount).toBe(0);
    expect(seg.entries).toHaveLength(3);
    expect(seg.entries[0].streamOffset).toBe(0n);
    expect(seg.entries[1].streamOffset).toBe(100000n);
    expect(seg.entries[2].streamOffset).toBe(200000n);
  });
});

describe('resolveFrameOffset', () => {
  it('resolves frame offset using stream offsets', () => {
    const buffer = buildIndexTableSegmentBuffer([
      { streamOffset: 0n,   isKeyframe: true  },
      { streamOffset: 100n, isKeyframe: false },
      { streamOffset: 250n, isKeyframe: true  },
    ]);
    const klv = readKLV(buffer, 0);
    const seg = parseIndexTableSegment(buffer, klv);

    const essenceStart = 1000n;
    const resolved = resolveFrameOffset([seg], 1n, essenceStart);
    expect(resolved).not.toBeNull();
    expect(resolved!.byteOffset).toBe(essenceStart + 100n);
  });

  it('returns null for out-of-range frame', () => {
    const buffer = buildIndexTableSegmentBuffer([
      { streamOffset: 0n, isKeyframe: true },
    ]);
    const klv = readKLV(buffer, 0);
    const seg = parseIndexTableSegment(buffer, klv);
    expect(resolveFrameOffset([seg], 99n, 0n)).toBeNull();
  });
});

describe('gopLengthFromKeyframe', () => {
  // Build a minimal VBE segment directly. Keyframes carry flags bit 7 = 0 (the same convention
  // resolveFrameOffset uses); other frames set bit 7. `kf` is the keyframe pattern per frame.
  function vbeSegment(kf: boolean[], start = 0n): IndexTableSegment {
    return {
      indexStartPosition: start,
      indexDuration: BigInt(kf.length),
      editUnitByteCount: 0,
      indexSID: 1,
      bodySID: 1,
      sliceCount: 0,
      posTableCount: 0,
      entries: kf.map((isKf, i) => ({
        temporalOffset: 0,
        keyFrameOffset: 0,
        flags: isKf ? 0x00 : 0x80,
        streamOffset: BigInt(i * 1000),
      })),
    };
  }

  it('returns the distance to the next keyframe (GOP length)', () => {
    // I P P I P  → GOP at frame 0 is 3 frames long, GOP at frame 3 runs to the end (2 frames).
    const seg = vbeSegment([true, false, false, true, false]);
    expect(gopLengthFromKeyframe([seg], 0n)).toBe(3);
    expect(gopLengthFromKeyframe([seg], 3n)).toBe(2);
  });

  it('holds to the end of the segment when no further keyframe follows', () => {
    const seg = vbeSegment([true, false, false, false]);
    expect(gopLengthFromKeyframe([seg], 0n)).toBe(4);
  });

  it('returns 1 for constant-byte-extent (all-intra) segments', () => {
    const seg: IndexTableSegment = {
      indexStartPosition: 0n, indexDuration: 100n, editUnitByteCount: 150000,
      indexSID: 1, bodySID: 1, sliceCount: 0, posTableCount: 0, entries: [],
    };
    expect(gopLengthFromKeyframe([seg], 10n)).toBe(1);
  });

  it('returns 1 when the edit unit is not covered by any segment', () => {
    const seg = vbeSegment([true, false]);
    expect(gopLengthFromKeyframe([seg], 99n)).toBe(1);
  });

  it('honours a non-zero indexStartPosition', () => {
    const seg = vbeSegment([true, false, true], 100n);
    expect(gopLengthFromKeyframe([seg], 100n)).toBe(2);
  });
});

describe('CBG (constant byte count) seeking', () => {
  // A minimal header-partition CBG segment: declares editUnitByteCount, no entries, indexDuration 0.
  const cbg = makeSegment({ editUnitByteCount: 150000, indexDuration: 0n, bodySID: 1 });

  it('resolveFrameOffset uses the byte-count math beyond indexDuration', () => {
    const essenceStart = 1000n;
    const r = resolveFrameOffset([cbg], 1000n, essenceStart, 1);
    expect(r).not.toBeNull();
    expect(r!.byteOffset).toBe(essenceStart + 150000n * 1000n);
    expect(r!.isKeyframe).toBe(true);
    expect(r!.nearestKeyframeEditUnit).toBe(1000n);
  });

  it('resolveExactFrameOffset agrees with resolveFrameOffset for CBG', () => {
    const r1 = resolveFrameOffset([cbg], 42n, 0n, 1);
    const r2 = resolveExactFrameOffset([cbg], 42n, 0n, 1);
    expect(r2!.byteOffset).toBe(r1!.byteOffset);
    expect(r2!.byteOffset).toBe(150000n * 42n);
  });

  it('resolveCbgFrameOffset honours a non-zero indexStartPosition', () => {
    const seg = makeSegment({ editUnitByteCount: 1000, indexStartPosition: 100n });
    expect(resolveCbgFrameOffset(seg, 150n, 0n).byteOffset).toBe(1000n * 50n);
    // Frames before the segment start clamp to offset 0 rather than going negative.
    expect(resolveCbgFrameOffset(seg, 50n, 0n).byteOffset).toBe(0n);
  });

  it('findCbgSegment respects BodySID matching', () => {
    expect(findCbgSegment([cbg], 1)).toBe(cbg);       // exact match
    expect(findCbgSegment([cbg], 0)).toBe(cbg);        // unknown video SID matches anything
    expect(findCbgSegment([cbg], 2)).toBeNull();       // wrong SID is not selected
    const agnostic = makeSegment({ editUnitByteCount: 200, bodySID: 0 });
    expect(findCbgSegment([agnostic], 7)).toBe(agnostic); // segment SID 0 = unspecified, accepted
  });

  it('does NOT use a CBG segment that belongs to a different essence stream', () => {
    // Audio (or other) CBG segment with bodySID 2 must not be used to seek the video (SID 1).
    const r = resolveFrameOffset([cbg], 1000n, 0n, 2);
    expect(r).toBeNull(); // no entries, no matching CBG → unresolved
  });
});

describe('classifyIndexMode', () => {
  const cbg = makeSegment({ editUnitByteCount: 150000, bodySID: 1 });
  const vbe = makeSegment({
    bodySID: 1,
    indexDuration: 2n,
    entries: [
      { temporalOffset: 0, keyFrameOffset: 0, flags: 0x00, streamOffset: 0n },
      { temporalOffset: 0, keyFrameOffset: 0, flags: 0x80, streamOffset: 500n },
    ],
  });

  it('detects cbg / vbe / none', () => {
    expect(classifyIndexMode([cbg], 1)).toBe('cbg');
    expect(classifyIndexMode([vbe], 1)).toBe('vbe');
    expect(classifyIndexMode([], 1)).toBe('none');
    expect(classifyIndexMode([makeSegment({ bodySID: 1 })], 1)).toBe('none'); // empty segment
  });

  it('prefers cbg when both a CBG and a VBE segment are present', () => {
    expect(classifyIndexMode([vbe, cbg], 1)).toBe('cbg');
    expect(classifyIndexMode([cbg, vbe], 1)).toBe('cbg');
  });

  it('matches BodySID-agnostically when the video SID is unknown (0)', () => {
    expect(classifyIndexMode([vbe], 0)).toBe('vbe');
    expect(classifyIndexMode([cbg], 0)).toBe('cbg');
  });

  it('ignores a VBE segment for a different essence stream', () => {
    const audioVbe = makeSegment({ ...vbe, bodySID: 2 });
    expect(classifyIndexMode([audioVbe], 1)).toBe('none');
  });
});

describe('long-GOP keyframe predicate + helpers', () => {
  // A ffmpeg-style VBE GOP of 12: keyframe at 0 and 12. Prediction bits (0x30) are populated, and
  // the legacy random-access bit (0x80) is set on the keyframes — i.e. INVERTED, so the legacy test
  // would mis-detect every frame. The auto-detecting predicate must use the 0x30 bits instead.
  function entry(flags: number, streamOffset: bigint, temporalOffset = 0): IndexEntry {
    return { temporalOffset, keyFrameOffset: 0, flags, streamOffset };
  }
  function ffmpegGop(): IndexTableSegment {
    const entries: IndexEntry[] = [];
    for (let i = 0; i < 24; i++) {
      const isKf = i % 12 === 0;
      // keyframe: 0x80 set (legacy inverted), 0x30 clear. predicted: 0x10 (P) / 0x30 not all clear.
      entries.push(entry(isKf ? 0x80 : 0x10, BigInt(i * 1000)));
    }
    return makeSegment({ bodySID: 1, indexStartPosition: 0n, indexDuration: 24n, entries });
  }

  it('detects prediction-bit usage and inverts the keyframe test accordingly', () => {
    const seg = ffmpegGop();
    expect(segUsesPredictionFlags(seg)).toBe(true);
    expect(isKeyframeEntry(seg, seg.entries[0])).toBe(true);   // 0x80 set but 0x30 clear → keyframe
    expect(isKeyframeEntry(seg, seg.entries[1])).toBe(false);  // 0x10 → predicted
    expect(isKeyframeEntry(seg, seg.entries[12])).toBe(true);
  });

  it('falls back to the legacy 0x80 test when no prediction bits are present', () => {
    const seg = makeSegment({
      bodySID: 1, indexStartPosition: 0n, indexDuration: 3n,
      entries: [entry(0x00, 0n), entry(0x80, 100n), entry(0x80, 200n)],
    });
    expect(segUsesPredictionFlags(seg)).toBe(false);
    expect(isKeyframeEntry(seg, seg.entries[0])).toBe(true);  // 0x80 clear → keyframe (legacy)
    expect(isKeyframeEntry(seg, seg.entries[1])).toBe(false);
  });

  it('resolveEntryMeta returns per-frame temporalOffset / flags / isKeyframe', () => {
    const seg = ffmpegGop();
    const m0 = resolveEntryMeta([seg], 0n, 1)!;
    expect(m0.isKeyframe).toBe(true);
    const m5 = resolveEntryMeta([seg], 5n, 1)!;
    expect(m5.isKeyframe).toBe(false);
    expect(m5.flags).toBe(0x10);
    expect(resolveEntryMeta([seg], 99n, 1)).toBeNull(); // out of range
  });

  it('findKeyframeFloor / findKeyframeCeil snap to GOP boundaries', () => {
    const seg = [ffmpegGop()];
    expect(findKeyframeFloor(seg, 5n, 1)).toBe(0n);
    expect(findKeyframeFloor(seg, 12n, 1)).toBe(12n);
    expect(findKeyframeFloor(seg, 13n, 1)).toBe(12n);
    expect(findKeyframeCeil(seg, 0n, 1)).toBe(0n);
    expect(findKeyframeCeil(seg, 5n, 1)).toBe(12n);
    expect(findKeyframeCeil(seg, 12n, 1)).toBe(12n);
  });

  it('longGopGopLength measures the distance to the next keyframe', () => {
    expect(longGopGopLength([ffmpegGop()], 0n, 1)).toBe(12);
    expect(longGopGopLength([ffmpegGop()], 12n, 1)).toBe(12);
  });

  it('resolveLongGopKeyframe snaps a mid-GOP edit unit back to its keyframe byte offset', () => {
    const r = resolveLongGopKeyframe([ffmpegGop()], 7n, 1_000_000n, 1)!;
    expect(r.nearestKeyframeEditUnit).toBe(0n);
    expect(r.byteOffset).toBe(1_000_000n); // essenceStart + entry[0].streamOffset (0)
    expect(r.isKeyframe).toBe(true);
    const r2 = resolveLongGopKeyframe([ffmpegGop()], 13n, 0n, 1)!;
    expect(r2.nearestKeyframeEditUnit).toBe(12n);
    expect(r2.byteOffset).toBe(12_000n);
  });
});
