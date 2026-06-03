/**
 * Reconstruct H.264 display order (PTS) and contiguous decode order (DTS) for a run of Long-GOP
 * access units, so the fMP4 fragmenter's signed composition-time-offset places B-frames correctly.
 *
 * The fragmenter (`buildRawVideoSegment`) sets `baseTime = frames[0].dts` and gives every sample the
 * same duration, deriving each sample's display time as `dts₀ + i + (ptsᵢ − dtsᵢ)`. That lands on
 * the intended `ptsᵢ` **iff `dtsᵢ = dts₀ + i`** — contiguous decode-order numbering. So this resolver
 * always emits:
 *     dtsⱼ = startStorageEU + j          (j = kept-frame index in decode order)
 *     ptsⱼ = startStorageEU + rankⱼ      (rankⱼ = display position among kept frames)
 * giving `CTS = rankⱼ − j`, which is exactly what the fragmenter expects.
 *
 * The input run MUST consist of whole GOPs starting at a keyframe (the worker aligns fetches to GOP
 * boundaries), so per-GOP POC ranking equals the global display order and adjacent segments tile.
 *
 * Tiers:
 *  - Tier 1: the index carries real `temporalOffset` → use it directly, no bitstream parsing.
 *  - Tier 2: parse SPS/slice POC, rank each GOP by POC, drop open-GOP leading B's at a seek boundary.
 *  - Fallback: any slice parse failure or field picture → zero-CTS decode order (safe, degraded).
 */
import { iterNals, firstSliceNal, parseSliceHeaderPoc, PocComputer } from './h264-poc.js';
import type { SpsPocInfo, PpsPocInfo } from './h264-poc.js';
import type { EntryMeta } from '../parser/index-table.js';

export interface ReorderInputFrame {
  /** AVCC (length-prefixed) access-unit bytes. */
  avcc: Uint8Array;
  /** Storage edit unit (decode order; contiguous from the run start). */
  editUnit: bigint;
  /** Index-entry metadata (temporalOffset / flags / isKeyframe), when the file has a VBE index. */
  meta?: EntryMeta | null;
}

export interface ReorderOptions {
  sps: SpsPocInfo;
  ppsFlagMap: Map<number, PpsPocInfo>;
  /** Edit unit of the first frame in the run (= frames[0].editUnit; the GOP-head keyframe). */
  startStorageEU: bigint;
  /** True on the first fetch after a seek/scrub: drop open-GOP leading B's of the first GOP. */
  isRunKeyframeBoundary: boolean;
  /** AVCC NALU length-prefix size (default 4, matching the avcC lengthSizeMinusOne=3 we emit). */
  lengthSize?: number;
}

export interface ResolvedSample {
  pts: bigint;
  dts: bigint;
  isKeyframe: boolean;
  /** Index into the input `frames` array this sample came from. */
  sourceIndex: number;
}

/** A frame reduced to just what the ordering needs (lets the ranking logic be unit-tested directly). */
export interface ReorderItem {
  poc: number;
  /** Starts a new ranking segment (a keyframe / IDR / GOP head). */
  isGopHead: boolean;
  /** MSE sync-sample flag (random-access point). */
  isSync: boolean;
  /** A field picture (field_pic_flag = 1) — unsupported by POC ranking; triggers fallback. */
  fieldPic: boolean;
  sourceIndex: number;
}

/**
 * Pure ordering core: given per-frame POC items in decode order (whole GOPs, first item a GOP head),
 * produce contiguous-DTS / ranked-PTS samples. Returns null to signal "fall back to decode order"
 * (a field picture was present). `startStorageEU` and `dropLeadingB` mirror {@link ReorderOptions}.
 */
export function computeReorder(
  items: ReorderItem[],
  startStorageEU: bigint,
  dropLeadingB: boolean,
): ResolvedSample[] | null {
  if (items.length === 0) return [];
  if (items.some(it => it.fieldPic)) return null;

  // Segment into GOPs at each head (index 0 always begins the first segment).
  const segments: ReorderItem[][] = [];
  for (const it of items) {
    if (it.isGopHead || segments.length === 0) segments.push([it]);
    else segments[segments.length - 1].push(it);
  }

  // Open-GOP leading-B drop: in the first GOP only, discard frames that display before the head
  // (POC < head POC) — they reference the previous GOP we seeked away from. No-op for closed GOPs
  // (the IDR has the lowest POC), which is the XAVC-L target. (For genuinely open GOPs this makes
  // the boundary segment display contiguously from the keyframe; a small display gap to the *next*
  // segment can remain because storage and display edit units diverge there — handled correctly
  // only by the Tier-1 temporalOffset path. The accurate post-seek settle masks it in practice.)
  if (dropLeadingB && segments.length > 0) {
    const first = segments[0];
    const headPoc = first[0].poc;
    segments[0] = first.filter((it, i) => i === 0 || it.poc >= headPoc);
  }

  const out: ResolvedSample[] = [];
  let decodeIndex = 0;   // contiguous over kept frames, in decode order
  let displayBase = 0;   // running count of kept frames in prior segments
  for (const seg of segments) {
    // Display order within this GOP = ascending POC. Stable so equal POCs keep decode order.
    const ranked = seg.map((it, i) => ({ it, i })).sort((a, b) => a.it.poc - b.it.poc || a.i - b.i);
    const rankOf = new Map<number, number>();
    ranked.forEach((r, displayPos) => rankOf.set(r.i, displayBase + displayPos));

    seg.forEach((it, i) => {
      out.push({
        dts: startStorageEU + BigInt(decodeIndex),
        pts: startStorageEU + BigInt(rankOf.get(i)!),
        isKeyframe: it.isSync,
        sourceIndex: it.sourceIndex,
      });
      decodeIndex++;
    });
    displayBase += seg.length;
  }
  return out;
}

/** Fallback: decode order, zero composition offset. `isKeyframe` from index meta / IDR detection. */
function decodeOrderFallback(frames: ReorderInputFrame[], startStorageEU: bigint, lengthSize: number): ResolvedSample[] {
  return frames.map((f, i) => {
    let isKeyframe = f.meta?.isKeyframe;
    if (isKeyframe === undefined) {
      const s = firstSliceNal(f.avcc, lengthSize);
      isKeyframe = s?.type === 5; // IDR
    }
    return {
      pts: startStorageEU + BigInt(i),
      dts: startStorageEU + BigInt(i),
      isKeyframe: !!isKeyframe,
      sourceIndex: i,
    };
  });
}

/** True if the run's index metadata carries a usable (non-all-zero) temporal offset (Tier 1). */
function hasRealTemporalOffset(frames: ReorderInputFrame[]): boolean {
  return frames.some(f => f.meta && f.meta.temporalOffset !== 0);
}

/**
 * Resolve PTS/DTS/isKeyframe for a decode-order run of Long-GOP access units. See the module header
 * for the tiers and the contiguous-DTS invariant. Always returns samples in decode order (dropped
 * leading B's excluded); each sample's `sourceIndex` maps back to the input frame's bytes.
 */
export function resolveReorder(frames: ReorderInputFrame[], opts: ReorderOptions): ResolvedSample[] {
  const lengthSize = opts.lengthSize ?? 4;
  const { sps, ppsFlagMap, startStorageEU, isRunKeyframeBoundary } = opts;
  if (frames.length === 0) return [];

  // Tier 1: trust the index's temporalOffset. Each frame's display edit unit (within the run) is its
  // storage index + temporalOffset; DTS is the contiguous decode index, PTS the display edit unit.
  if (hasRealTemporalOffset(frames)) {
    let kept = frames.map((f, i) => ({ f, i, displayEu: i + (f.meta?.temporalOffset ?? 0) }));
    // On the first run after a seek/scrub, drop the open-GOP leading B's — frames that display before
    // the GOP head (frames[0]); they reference the previous GOP we seeked away from. (No-op for a
    // closed GOP, where the head has the lowest display position — so the verified XAVC path is
    // unchanged, as is every non-boundary run, where j === i and PTS/DTS match the prior behaviour.)
    if (isRunKeyframeBoundary && kept.length > 0) {
      const headDisplay = kept[0].displayEu;
      kept = kept.filter((k, idx) => idx === 0 || k.displayEu >= headDisplay);
    }
    return kept.map((k, j) => ({
      dts: startStorageEU + BigInt(j),
      pts: startStorageEU + BigInt(k.displayEu),
      isKeyframe: !!k.f.meta?.isKeyframe,
      sourceIndex: k.i,
    }));
  }

  // Tier 2: parse POC and rank. Reset the POC predictor once; it re-anchors itself at each IDR.
  const poc = new PocComputer();
  poc.reset();
  const items: ReorderItem[] = [];
  for (let i = 0; i < frames.length; i++) {
    const slice = firstSliceNal(frames[i].avcc, lengthSize);
    if (!slice) return decodeOrderFallback(frames, startStorageEU, lengthSize);
    const sh = parseSliceHeaderPoc(slice, sps, ppsFlagMap);
    if (!sh) return decodeOrderFallback(frames, startStorageEU, lengthSize);
    if (sh.fieldPicFlag) return decodeOrderFallback(frames, startStorageEU, lengthSize);

    const pocVal = poc.computeFrame(sh, sps);
    // A GOP head is an IDR (or an index-flagged keyframe). Sync samples (random-access) are IDRs;
    // the index keyframe flag is honoured too when present.
    const isKeyframe = sh.isIdr || !!frames[i].meta?.isKeyframe;
    items.push({
      poc: pocVal,
      isGopHead: isKeyframe,
      isSync: isKeyframe,
      fieldPic: false,
      sourceIndex: i,
    });
  }

  const samples = computeReorder(items, startStorageEU, isRunKeyframeBoundary);
  if (samples === null) return decodeOrderFallback(frames, startStorageEU, lengthSize);
  return samples;
}

/** Whether an AVCC access unit contains any B slice — used to detect Long-GOP at init. */
export function accessUnitHasBSlice(
  avcc: Uint8Array,
  sps: SpsPocInfo,
  ppsFlagMap: Map<number, PpsPocInfo>,
  lengthSize = 4,
): boolean {
  for (const n of iterNals(avcc, lengthSize)) {
    if (n.type !== 1 && n.type !== 5) continue;
    const sh = parseSliceHeaderPoc(n, sps, ppsFlagMap);
    if (sh && sh.sliceType === 1) return true; // 1 == B
  }
  return false;
}
