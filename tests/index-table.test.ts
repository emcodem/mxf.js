import { describe, it, expect } from 'vitest';
import { parseIndexTableSegment, resolveFrameOffset, gopLengthFromKeyframe } from '../src/parser/index-table.js';
import type { IndexTableSegment } from '../src/parser/index-table.js';
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
