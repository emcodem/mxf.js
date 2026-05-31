import { SCRUB_CACHE_MAX } from '../core/constants.js';

/**
 * LRU cache of already-encoded scrub-preview fMP4 video segments, keyed by GOP-head keyframe edit
 * unit. A preview segment is fully determined by its keyframe (fixed baseTime + GOP-length stretch),
 * so it can be re-served verbatim. This is what makes MPEG-2 scrubbing usable: the costly part is
 * the per-keyframe JS MPEG-2 decode + H.264 encode, and without a cache every drag position — even
 * repeated passes over the same region, or several positions within one GOP — pays it again, so the
 * picture lags further behind the thumb the faster you drag. With the cache, each GOP head is decoded
 * at most once per session and revisits are instant. Cleared on each new file load.
 */
export class ScrubSegmentCache {
  private readonly map = new Map<number, Uint8Array>();

  constructor(private readonly max = SCRUB_CACHE_MAX) {}

  get(keyframe: number): Uint8Array | undefined {
    return this.map.get(keyframe);
  }

  /** Insert a segment, evicting the oldest entry first if at capacity (insertion-order LRU). */
  set(keyframe: number, segment: Uint8Array): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value as number | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(keyframe, segment);
  }

  clear(): void {
    this.map.clear();
  }
}
