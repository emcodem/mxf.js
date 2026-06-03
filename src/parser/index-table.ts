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
  /** Signed DTS offset (edit units) from the index entry, when available (long-GOP Tier-1). */
  temporalOffset?: number;
  /** Raw index-entry flags byte, when available. */
  flags?: number;
}

/** Per-edit-unit index metadata the long-GOP path needs (reorder + keyframe), from a VBE entry. */
export interface EntryMeta {
  temporalOffset: number;
  flags: number;
  isKeyframe: boolean;
}

const predictionFlagCache = new WeakMap<IndexTableSegment, boolean>();

/**
 * Whether a segment populates the MPEG picture-coding "prediction" bits (flags & 0x30). ffmpeg-style
 * VBE indexes set these (and leave the legacy random-access bit 0x80 in a form that mis-detects every
 * frame as a keyframe), so their presence selects the correct keyframe predicate. Memoized per segment.
 */
export function segUsesPredictionFlags(seg: IndexTableSegment): boolean {
  let cached = predictionFlagCache.get(seg);
  if (cached === undefined) {
    cached = seg.entries.some(e => (e.flags & 0x30) !== 0);
    predictionFlagCache.set(seg, cached);
  }
  return cached;
}

/**
 * Auto-detecting keyframe predicate for a VBE index entry. If the segment populates the prediction
 * bits (see {@link segUsesPredictionFlags}) a keyframe is one whose picture-coding bits are clear
 * (`(flags & 0x30) === 0`, i.e. intra-coded); otherwise the legacy random-access test
 * (`(flags & 0x80) === 0`) is used. This is the predicate the long-GOP path resolves through; the
 * MPEG-2 / XAVC-Intra sites keep their original `(flags & 0x80) === 0` test untouched.
 */
export function isKeyframeEntry(seg: IndexTableSegment, entry: IndexEntry): boolean {
  if (segUsesPredictionFlags(seg)) return (entry.flags & 0x30) === 0;
  return (entry.flags & 0x80) === 0;
}

/**
 * Find the first segment whose [indexStartPosition, +indexDuration) range covers `editUnit`, with
 * the entry index within it. Unlike {@link entrySegmentFor} (the long-GOP path) this does NOT filter
 * by BodySID and does NOT require an entry array — it mirrors the legacy MPEG-2 / AVC-Intra seek
 * resolvers, which run after their caller has already checked for a CBG segment, and which keep the
 * legacy `(flags & 0x80) === 0` keyframe test (see CLAUDE.md — intentionally distinct from the
 * long-GOP auto-detecting predicate).
 */
function findCoveringSegment(
  segments: IndexTableSegment[],
  editUnit: bigint,
): { seg: IndexTableSegment; entryIdx: number } | null {
  for (const seg of segments) {
    const segEnd = seg.indexStartPosition + seg.indexDuration;
    if (editUnit < seg.indexStartPosition || editUnit >= segEnd) continue;
    return { seg, entryIdx: Number(editUnit - seg.indexStartPosition) };
  }
  return null;
}

function entrySegmentFor(
  segments: IndexTableSegment[],
  editUnit: bigint,
  videoBodySID: number,
): { seg: IndexTableSegment; idx: number } | null {
  for (const seg of segments) {
    if (seg.entries.length === 0) continue;
    if (videoBodySID !== 0 && seg.bodySID !== 0 && seg.bodySID !== videoBodySID) continue;
    const segEnd = seg.indexStartPosition + seg.indexDuration;
    if (editUnit < seg.indexStartPosition || editUnit >= segEnd) continue;
    const idx = Number(editUnit - seg.indexStartPosition);
    if (idx < 0 || idx >= seg.entries.length) continue;
    return { seg, idx };
  }
  return null;
}

/** Per-edit-unit reorder + keyframe metadata from the VBE entry array (long-GOP path). */
export function resolveEntryMeta(
  segments: IndexTableSegment[],
  editUnit: bigint,
  videoBodySID = 0,
): EntryMeta | null {
  const hit = entrySegmentFor(segments, editUnit, videoBodySID);
  if (!hit) return null;
  const entry = hit.seg.entries[hit.idx];
  return {
    temporalOffset: entry.temporalOffset,
    flags: entry.flags,
    isKeyframe: isKeyframeEntry(hit.seg, entry),
  };
}

/** Largest keyframe edit unit ≤ `editUnit` (long-GOP seek snap), using {@link isKeyframeEntry}. */
export function findKeyframeFloor(
  segments: IndexTableSegment[],
  editUnit: bigint,
  videoBodySID = 0,
): bigint | null {
  const hit = entrySegmentFor(segments, editUnit, videoBodySID);
  if (!hit) return null;
  const { seg } = hit;
  for (let i = hit.idx; i >= 0; i--) {
    if (isKeyframeEntry(seg, seg.entries[i])) return seg.indexStartPosition + BigInt(i);
  }
  return null;
}

/**
 * Resolve the preceding-keyframe random-access point for a long-GOP seek: snaps `editUnit` back to
 * the nearest keyframe (via {@link findKeyframeFloor}) and returns that keyframe's byte offset.
 * Returns null if no VBE entry segment covers the edit unit (caller falls back to other strategies).
 */
export function resolveLongGopKeyframe(
  segments: IndexTableSegment[],
  editUnit: bigint,
  essenceContainerStart: bigint,
  videoBodySID = 0,
): ResolvedOffset | null {
  const kf = findKeyframeFloor(segments, editUnit, videoBodySID);
  if (kf === null) return null;
  const hit = entrySegmentFor(segments, kf, videoBodySID);
  if (!hit) return null;
  const entry = hit.seg.entries[hit.idx];
  return {
    byteOffset: essenceContainerStart + entry.streamOffset,
    isKeyframe: true,
    nearestKeyframeEditUnit: kf,
    temporalOffset: entry.temporalOffset,
    flags: entry.flags,
  };
}

/**
 * Smallest keyframe edit unit ≥ `editUnit` (long-GOP fetch end-alignment), using {@link isKeyframeEntry}.
 * Returns the end of the covering segment (indexStartPosition + indexDuration) if no further keyframe
 * exists — i.e. "fetch to the end". Returns null if no VBE entry segment covers the edit unit.
 */
export function findKeyframeCeil(
  segments: IndexTableSegment[],
  editUnit: bigint,
  videoBodySID = 0,
): bigint | null {
  const hit = entrySegmentFor(segments, editUnit, videoBodySID);
  if (!hit) return null;
  const { seg } = hit;
  for (let i = hit.idx; i < seg.entries.length; i++) {
    if (isKeyframeEntry(seg, seg.entries[i])) return seg.indexStartPosition + BigInt(i);
  }
  return seg.indexStartPosition + BigInt(seg.entries.length);
}

/** Long-GOP GOP length: frames from `keyframeEditUnit` to the next keyframe, using {@link isKeyframeEntry}. */
export function longGopGopLength(
  segments: IndexTableSegment[],
  keyframeEditUnit: bigint,
  videoBodySID = 0,
): number {
  const hit = entrySegmentFor(segments, keyframeEditUnit, videoBodySID);
  if (!hit) return 1;
  const { seg, idx } = hit;
  for (let i = idx + 1; i < seg.entries.length; i++) {
    if (isKeyframeEntry(seg, seg.entries[i])) return i - idx;
  }
  return Math.max(1, seg.entries.length - idx);
}

/**
 * Find an index segment that declares a constant edit-unit byte count (CBG / Constant Byte Group)
 * applicable to the given video BodySID. Standard OP1a CBG files put a minimal IndexTableSegment in
 * the header partition that only declares `editUnitByteCount` (often with `indexDuration === 0` and
 * no entry array), so this must NOT depend on the segment covering the requested edit unit.
 *
 * BodySID matching is permissive: `videoBodySID === 0` (unknown) matches anything, and a segment
 * with `bodySID === 0` (unspecified) is accepted too. Passing 0 preserves legacy call sites.
 */
export function findCbgSegment(
  segments: IndexTableSegment[],
  videoBodySID = 0
): IndexTableSegment | null {
  for (const seg of segments) {
    if (seg.editUnitByteCount <= 0) continue;
    if (videoBodySID === 0 || seg.bodySID === videoBodySID || seg.bodySID === 0) return seg;
  }
  return null;
}

/**
 * Classify the seeking strategy a set of index segments supports, for the given video BodySID:
 * - 'cbg'  if a constant-byte-count segment applies (see {@link findCbgSegment}),
 * - 'vbe'  if a (BodySID-matching) segment carries a per-frame entry array,
 * - 'none' otherwise (no usable index — caller must scan / seek by offset).
 * Permissive BodySID matching: `videoBodySID === 0` matches anything; a segment `bodySID === 0` is
 * treated as unspecified and accepted.
 */
export function classifyIndexMode(
  segments: IndexTableSegment[],
  videoBodySID = 0
): 'cbg' | 'vbe' | 'none' {
  if (findCbgSegment(segments, videoBodySID)) return 'cbg';
  const hasVbe = segments.some(s =>
    s.entries.length > 0 &&
    (videoBodySID === 0 || s.bodySID === videoBodySID || s.bodySID === 0)
  );
  return hasVbe ? 'vbe' : 'none';
}

/**
 * Resolve a frame's byte offset purely from the constant edit-unit byte count, ignoring the
 * segment's `indexDuration` bound: `offset = essenceStart + editUnitByteCount * (editUnit - indexStartPosition)`.
 * Every CBG edit unit is a random-access point, so `isKeyframe` is always true.
 */
export function resolveCbgFrameOffset(
  seg: IndexTableSegment,
  editUnit: bigint,
  essenceContainerStart: bigint
): ResolvedOffset {
  const rel = editUnit - seg.indexStartPosition;
  const offset = BigInt(seg.editUnitByteCount) * (rel < 0n ? 0n : rel);
  return {
    byteOffset: essenceContainerStart + offset,
    isKeyframe: true,
    nearestKeyframeEditUnit: editUnit,
  };
}

/**
 * Resolve the byte offset (relative to the essence container start) for a given edit unit.
 * essenceContainerStart: absolute file offset of first essence byte in the container.
 */
export function resolveFrameOffset(
  segments: IndexTableSegment[],
  editUnit: bigint,
  essenceContainerStart: bigint,
  videoBodySID = 0
): ResolvedOffset | null {
  // CBG (constant byte count) takes precedence: the math applies to every frame regardless of
  // whether a declaring segment's indexDuration covers it.
  const cbg = findCbgSegment(segments, videoBodySID);
  if (cbg) return resolveCbgFrameOffset(cbg, editUnit, essenceContainerStart);

  const hit = findCoveringSegment(segments, editUnit);
  if (!hit) return null;
  const { seg, entryIdx } = hit;

  if (seg.editUnitByteCount > 0) {
    // Constant byte extent: simple multiplication
    const offset = BigInt(seg.editUnitByteCount) * (editUnit - seg.indexStartPosition);
    return { byteOffset: essenceContainerStart + offset, isKeyframe: true, nearestKeyframeEditUnit: editUnit };
  }

  if (entryIdx >= seg.entries.length) return null;
  const entry = seg.entries[entryIdx];
  const isKeyframe = (entry.flags & 0x80) === 0; // flag bit 7 set means NOT a keyframe in some variants
  const nearestIdx = entryIdx + entry.keyFrameOffset;
  const nearestEU = seg.indexStartPosition + BigInt(nearestIdx);
  const kfEntry = seg.entries[nearestIdx] ?? entry;

  return {
    byteOffset: essenceContainerStart + kfEntry.streamOffset,
    isKeyframe,
    nearestKeyframeEditUnit: nearestEU,
  };
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
  const hit = findCoveringSegment(segments, keyframeEditUnit);
  if (!hit) return 1;
  const { seg } = hit;

  if (seg.editUnitByteCount > 0) return 1; // CBE: every edit unit is a keyframe

  const startIdx = Number(keyframeEditUnit - seg.indexStartPosition);
  for (let i = startIdx + 1; i < seg.entries.length; i++) {
    if ((seg.entries[i].flags & 0x80) === 0) return i - startIdx;
  }
  // No further keyframe in this segment: hold to the end of the segment.
  return Math.max(1, seg.entries.length - startIdx);
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
  essenceContainerStart: bigint,
  videoBodySID = 0
): ResolvedOffset | null {
  // CBG: exact and snapped resolutions coincide (every frame is its own random-access point).
  const cbg = findCbgSegment(segments, videoBodySID);
  if (cbg) return resolveCbgFrameOffset(cbg, editUnit, essenceContainerStart);

  const hit = findCoveringSegment(segments, editUnit);
  if (!hit) return null;
  const { seg, entryIdx } = hit;

  if (seg.editUnitByteCount > 0) {
    const offset = BigInt(seg.editUnitByteCount) * (editUnit - seg.indexStartPosition);
    return { byteOffset: essenceContainerStart + offset, isKeyframe: true, nearestKeyframeEditUnit: editUnit };
  }

  if (entryIdx >= seg.entries.length) return null;
  const entry = seg.entries[entryIdx];
  return {
    byteOffset: essenceContainerStart + entry.streamOffset,
    isKeyframe: (entry.flags & 0x80) === 0,
    nearestKeyframeEditUnit: editUnit,
  };
}
