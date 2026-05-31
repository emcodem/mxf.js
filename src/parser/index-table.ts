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

/**
 * Number of frames in the GOP that begins at `keyframeEditUnit` — i.e. the distance forward
 * to the next keyframe (or to the end of the index if none follows). Returns at least 1.
 *
 * For CBE / all-intra files (editUnitByteCount > 0) every frame is a random-access point, so
 * the GOP length is 1. For VBE Long-GOP it scans the index entry flags forward for the next
 * keyframe. Used to stretch an I-frame-only preview sample so it covers its whole GOP on the
 * MSE timeline; a wrong value only degrades how far a scrub preview holds, it cannot corrupt
 * playback (the accurate settle re-decodes exact frames over the same range).
 */
export function gopLengthFromKeyframe(
  segments: IndexTableSegment[],
  keyframeEditUnit: bigint
): number {
  for (const seg of segments) {
    const segEnd = seg.indexStartPosition + seg.indexDuration;
    if (keyframeEditUnit < seg.indexStartPosition || keyframeEditUnit >= segEnd) continue;

    if (seg.editUnitByteCount > 0) return 1; // CBE: every edit unit is a keyframe

    const startIdx = Number(keyframeEditUnit - seg.indexStartPosition);
    for (let i = startIdx + 1; i < seg.entries.length; i++) {
      const isKeyframe = (seg.entries[i].flags & 0x80) === 0;
      if (isKeyframe) return i - startIdx;
    }
    // No further keyframe in this segment: hold to the end of the segment.
    return Math.max(1, seg.entries.length - startIdx);
  }
  return 1;
}

/**
 * Resolve the byte offset of an edit unit WITHOUT snapping back to its nearest keyframe.
 * resolveFrameOffset() deliberately returns the preceding keyframe's offset (so a seek lands
 * on a random-access point), but a decoder that is fed a continuous stream needs the exact,
 * consecutive bytes of each requested frame — snapping would re-feed already-decoded pictures.
 */
export function resolveExactFrameOffset(
  segments: IndexTableSegment[],
  editUnit: bigint,
  essenceContainerStart: bigint
): ResolvedOffset | null {
  for (const seg of segments) {
    const segEnd = seg.indexStartPosition + seg.indexDuration;
    if (editUnit < seg.indexStartPosition || editUnit >= segEnd) continue;

    if (seg.editUnitByteCount > 0) {
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
    return {
      byteOffset: essenceContainerStart + entry.streamOffset,
      isKeyframe: (entry.flags & 0x80) === 0,
      nearestKeyframeEditUnit: editUnit,
    };
  }
  return null;
}
