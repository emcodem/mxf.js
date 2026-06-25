/**
 * Pure helpers for byte-percentage seeking on index-less ('none') ALL-INTRA VOD files.
 *
 * With no index there is no edit-unit → byte map, but an all-intra stream is decodable from any
 * content package, so a seek to frame N is resolved approximately: jump to the byte at the same
 * percentage through the essence, then dig forward to the next content package (see
 * MxfFile.findPackageStartAtOrAfter) and play from there. The displayed content is offset from the
 * exact frame by the frame-size variance (negligible for near-CBR AVC-Intra); 'none' mode already
 * declares timecodes approximate. Forward play after the landing is exactly contiguous.
 *
 * Kept free of worker globals so they are unit-testable — see tests/noindex-intra.test.ts.
 */
import type { RandomIndexPackEntry } from '../mxf-file.js';

/**
 * End of the seekable essence byte span: the first footer/index partition (a RIP entry with
 * bodySID 0) lying above the essence start, else EOF. `[essenceStart, essenceEnd)` is the byte range
 * the byte-percentage map spans.
 */
export function essenceEndByte(ripEntries: RandomIndexPackEntry[], essenceStart: number, fileSize: number): number {
  let end = fileSize;
  for (const e of ripEntries) {
    const off = Number(e.byteOffset);
    if (e.bodySID === 0 && off > essenceStart && off < end) end = off;
  }
  return end;
}

/**
 * Approximate essence byte offset of `frame` by linear byte percentage across
 * `[essenceStart, essenceEnd)`. Frame 0 (and any non-positive frame, or unknown total) maps to the
 * essence start exactly; the percentage is clamped to [0, 1].
 */
export function approxEssenceByte(frame: number, totalFrames: number, essenceStart: number, essenceEnd: number): number {
  if (frame <= 0 || totalFrames <= 0) return essenceStart;
  const pct = Math.min(1, Math.max(0, frame / totalFrames));
  return essenceStart + Math.floor(pct * (essenceEnd - essenceStart));
}
