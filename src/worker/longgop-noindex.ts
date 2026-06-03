/**
 * Tier-3 (no-index) Long-GOP run selection.
 *
 * Given a decode-order stream of access units that the caller has positioned at/under the requested
 * start (the nearest known keyframe, else the essence start), pick the GOP run that encloses
 * `[startFrame, startFrame + frameCount)`:
 *   - anchor at the last IDR ≤ `startFrame` (discarding any earlier-scanned GOP),
 *   - keep whole GOPs, ending on a GOP boundary (the first IDR ≥ the window end, or EOF),
 *   - record every discovered IDR `(editUnit, byteOffset)` into the sparse index so later seeks
 *     resume nearby instead of rescanning from the start.
 *
 * Frames scanned *before* the enclosing keyframe are discarded as we go, so even a cold seek that
 * rescans from the file start stays memory-bounded (it never buffers the whole prefix).
 *
 * Kept free of worker globals (all dependencies are parameters) so it is unit-testable with a
 * synthetic access-unit stream — see `tests/longgop-noindex.test.ts`.
 */
import type { EssenceFrame } from '../essence/essence-extractor.js';
import { isAnnexB, annexBtoAVCC } from '../essence/avc-tools.js';
import { isIdrAccessUnit } from '../essence/h264-poc.js';
import type { SparseKeyframeIndex } from '../essence/sparse-keyframe-index.js';

/** Over-scan past the requested window to reach the next IDR. XAVC-L GOPs are small (≤ ~30). */
export const NOINDEX_GOP_LOOKAHEAD = 60;

export interface NoIndexRun {
  /** Kept access units in decode order, beginning on the enclosing IDR. */
  video: EssenceFrame[];
  /** Audio elements interleaved within the kept run (trimmed to `< nextFrame`). */
  audio: EssenceFrame[];
  /** Storage edit unit of the run's first (IDR) frame — the resolver's `startStorageEU`. */
  startStorageEU: number;
  /** Edit unit where the next fetch should start (a GOP boundary, or EOF+1). */
  nextFrame: number;
}

export interface NoIndexRunOpts {
  startFrame: number;
  frameCount: number;
  /** Video-frame count the `frames` iterable was created to emit (lets us tell hit-bound from EOF). */
  scanBound: number;
  sparseKf?: SparseKeyframeIndex | null;
  /** Returns true once a seek has superseded this scan; selection bails and returns null. */
  isAborted?: () => boolean;
}

export async function selectNoIndexLongGopRun(
  frames: AsyncIterable<EssenceFrame>,
  opts: NoIndexRunOpts,
): Promise<NoIndexRun | null> {
  const { startFrame, frameCount, scanBound, sparseKf, isAborted } = opts;
  const windowEnd = startFrame + frameCount;

  const video: EssenceFrame[] = [];
  const audio: EssenceFrame[] = [];
  let headEU: number | null = null;              // enclosing GOP head (last IDR ≤ startFrame)
  let lastInteriorEU = -1, lastInteriorIdx = -1; // most recent interior GOP head within the run
  let nextFrame = -1;
  let videoSeen = 0;

  for await (const f of frames) {
    if (isAborted?.()) return null;
    if (f.trackType === 'audio') {
      if (headEU !== null) audio.push(f);
      continue;
    }
    videoSeen++;
    const eu = Number(f.editUnit);
    const avcc = isAnnexB(f.data) ? new Uint8Array(annexBtoAVCC(f.data)) : new Uint8Array(f.data);
    const idr = isIdrAccessUnit(avcc);
    if (idr && f.byteOffset !== undefined) sparseKf?.record(f.editUnit, f.byteOffset);

    if (idr && eu <= startFrame) {
      // (Re)anchor at the closest IDR ≤ the requested start; drop any earlier-scanned GOP.
      headEU = eu;
      video.length = 0; audio.length = 0;
      lastInteriorEU = -1; lastInteriorIdx = -1;
      video.push(f);
      continue;
    }
    if (headEU === null) continue;                          // still before the enclosing keyframe
    if (idr && eu >= windowEnd) { nextFrame = eu; break; }  // GOP boundary past the window → run end
    if (idr) { lastInteriorEU = eu; lastInteriorIdx = video.length; }
    video.push(f);
  }

  if (video.length === 0) {
    // No enclosing IDR (stream didn't start on a keyframe at/under the target) — degrade gracefully;
    // the resolver will fall back to decode order for these bytes.
    return { video, audio, startStorageEU: startFrame, nextFrame: windowEnd };
  }
  if (nextFrame < 0) {
    // No boundary IDR seen. If we hit the lookahead cap the trailing GOP may be incomplete → trim it
    // so the run ends on a real boundary and the next fetch starts on a keyframe (no re-fetch
    // overlap). Otherwise we reached EOF — keep everything; the next fetch is past the end.
    if (videoSeen >= scanBound && lastInteriorIdx > 0) {
      nextFrame = lastInteriorEU;
      video.length = lastInteriorIdx;
      while (audio.length > 0 && Number(audio[audio.length - 1].editUnit) >= nextFrame) audio.pop();
    } else {
      nextFrame = Number(video[video.length - 1].editUnit) + 1;
    }
  }
  return { video, audio, startStorageEU: headEU as number, nextFrame };
}
