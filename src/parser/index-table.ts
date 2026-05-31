import { DataViewReader } from '../core/data-view-reader.js';
import { KLVPacket } from '../core/klv.js';

export interface IndexEntry {
  temporalOffset: number;  // signed byte: DTS offset relative to frame number
  keyFrameOffset: number;  // signed byte: offset back to nearest keyframe
  flags: number;           // bit 7 = 1 → keyframe, bit 6 = forward predicted
  streamOffset: bigint;    // byte offset from start of essence container
}

export interface IndexTableSegment {
  indexStartPosition: bigint;  // first edit unit covered
  indexDuration: bigint;       // number of edit units
  editUnitByteCount: number;   // 0 = variable, >0 = CBE (constant byte extent)
  indexSID: number;
  bodySID: number;
  sliceCount: number;
  posTableCount: number;
  entries: IndexEntry[];
}

// Local tags for Index Table Segment (fixed, no primer needed)
const TAG_INDEX_EDIT_UNIT_BYTE_COUNT = 0x3F05;
const TAG_INDEX_SID                  = 0x3F06;
const TAG_BODY_SID                   = 0x3F07;
const TAG_SLICE_COUNT                = 0x3F08;
const TAG_POS_TABLE_COUNT            = 0x3F0B;
const TAG_INDEX_START_POSITION       = 0x3F0C;
const TAG_INDEX_DURATION             = 0x3F0D;
const TAG_INDEX_ENTRY_ARRAY          = 0x3F0A;

export function parseIndexTableSegment(buffer: ArrayBuffer, klv: KLVPacket): IndexTableSegment {
  const r = new DataViewReader(buffer, klv.valueOffset);
  const end = klv.valueOffset + klv.valueLength;

  let indexStartPosition = 0n;
  let indexDuration = 0n;
  let editUnitByteCount = 0;
  let indexSID = 0;
  let bodySID = 0;
  let sliceCount = 0;
  let posTableCount = 0;
  const entries: IndexEntry[] = [];

  while (r.offset + 4 <= end) {
    const tag = r.readU16BE();
    const len = r.readU16BE();
    if (r.offset + len > end) break;
    const fieldOffset = r.offset;
    const v = new DataView(buffer, fieldOffset, len);

    switch (tag) {
      case TAG_INDEX_EDIT_UNIT_BYTE_COUNT:
        editUnitByteCount = v.getUint32(0, false);
        break;
      case TAG_INDEX_SID:
        indexSID = v.getUint32(0, false);
        break;
      case TAG_BODY_SID:
        bodySID = v.getUint32(0, false);
        break;
      case TAG_SLICE_COUNT:
        sliceCount = v.getUint8(0);
        break;
      case TAG_POS_TABLE_COUNT:
        posTableCount = v.getUint8(0);
        break;
      case TAG_INDEX_START_POSITION: {
        const hi = v.getInt32(0, false);
        const lo = v.getUint32(4, false);
        indexStartPosition = (BigInt(hi) << 32n) | BigInt(lo);
        break;
      }
      case TAG_INDEX_DURATION: {
        const hi = v.getInt32(0, false);
        const lo = v.getUint32(4, false);
        indexDuration = (BigInt(hi) << 32n) | BigInt(lo);
        break;
      }
      case TAG_INDEX_ENTRY_ARRAY: {
        // Batch array: 4-byte count, 4-byte item length, then entries
        const count = v.getUint32(0, false);
        const itemLen = v.getUint32(4, false);
        // Each entry: 1 byte temporal offset, 1 byte keyframe offset, 1 byte flags,
        //   then 8 bytes stream offset, then slice_count * 4 bytes, pos_table_count * 8 bytes
        const perEntrySliceBytes = sliceCount * 4;
        const perEntrPosBytes = posTableCount * 8;
        const baseEntrySize = 11 + perEntrySliceBytes + perEntrPosBytes;
        let entryBase = 8; // skip count + itemLen

        for (let i = 0; i < count && entryBase + baseEntrySize <= len; i++) {
          const temporalOffset = v.getInt8(entryBase);
          const keyFrameOffset = v.getInt8(entryBase + 1);
          const flags = v.getUint8(entryBase + 2);
          const offHi = v.getInt32(entryBase + 3, false);
          const offLo = v.getUint32(entryBase + 7, false);
          const streamOffset = (BigInt(offHi) << 32n) | BigInt(offLo);
          entries.push({ temporalOffset, keyFrameOffset, flags, streamOffset });
          entryBase += itemLen;
        }
        break;
      }
    }
    r.seek(fieldOffset + len);
  }

  return {
    indexStartPosition,
    indexDuration,
    editUnitByteCount,
    indexSID,
    bodySID,
    sliceCount,
    posTableCount,
    entries,
  };
}

export interface ResolvedOffset {
  byteOffset: bigint;
  isKeyframe: boolean;
  nearestKeyframeEditUnit: bigint;
}

/**
 * Resolve the byte offset (relative to the essence container start) for a given edit unit.
 * essenceContainerStart: absolute file offset of first essence byte in the container.
 */
export function resolveFrameOffset(
  segments: IndexTableSegment[],
  editUnit: bigint,
  essenceContainerStart: bigint
): ResolvedOffset | null {
  for (const seg of segments) {
    const segEnd = seg.indexStartPosition + seg.indexDuration;
    if (editUnit < seg.indexStartPosition || editUnit >= segEnd) continue;

    if (seg.editUnitByteCount > 0) {
      // Constant byte extent: simple multiplication
      const offset = BigInt(seg.editUnitByteCount) * (editUnit - seg.indexStartPosition);
      return {
        byteOffset: essenceContainerStart + offset,
        isKeyframe: true,
        nearestKeyframeEditUnit: editUnit,
      };
    }

    const entryIdx = Number(editUnit - seg.indexStartPosition);
    if (entryIdx >= seg.entries.length) return null;

    const entry = seg.entries[entryIdx];
    const isKeyframe = (entry.flags & 0x80) === 0; // flag bit 7 set means NOT a keyframe in some variants
    const kfOffset = entry.keyFrameOffset;
    const nearestIdx = entryIdx + kfOffset;
    const nearestEU = seg.indexStartPosition + BigInt(nearestIdx);

    const kfEntry = seg.entries[nearestIdx] ?? entry;

    return {
      byteOffset: essenceContainerStart + kfEntry.streamOffset,
      isKeyframe,
      nearestKeyframeEditUnit: nearestEU,
    };
  }
  return null;
}
