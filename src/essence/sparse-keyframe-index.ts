/**
 * Bounded, lazily-populated keyframe map for indexless (Tier-3, `indexMode: 'none'`) files. A
 * sequential scan records keyframe edit units → absolute byte offsets as a side effect; a later
 * seek consults `floor()` to start decoding at the nearest known keyframe rather than rescanning
 * from the start. The map is decimated (kept under `maxEntries`) so it never grows unbounded on a
 * long or growing file — coverage is sparse but monotonically useful, and a miss simply means
 * scanning from the previous known keyframe (or the essence start).
 */
export class SparseKeyframeIndex {
  /** Sorted ascending by edit unit. Parallel arrays keep the memory small. */
  private editUnits: bigint[] = [];
  private byteOffsets: bigint[] = [];
  private readonly maxEntries: number;
  /** Keep roughly every `stride`-th keyframe once the map is full (grows as the file is scanned). */
  private stride = 1;

  constructor(maxEntries = 4096) {
    this.maxEntries = Math.max(16, maxEntries);
  }

  /**
   * Record a discovered keyframe. Only strictly-forward edit units are appended (a re-scan of an
   * earlier region is ignored — the map stays sorted with a cheap push), the stride throttles how
   * dense it gets, and reaching `maxEntries` halves it via {@link decimate}.
   */
  record(editUnit: bigint, absByteOffset: bigint): void {
    const n = this.editUnits.length;
    if (n > 0) {
      if (editUnit <= this.editUnits[n - 1]) return;                 // not strictly forward
      if (this.stride > 1 && Number(editUnit - this.editUnits[n - 1]) < this.stride) return;
    }
    if (n >= this.maxEntries) this.decimate();
    this.editUnits.push(editUnit);
    this.byteOffsets.push(absByteOffset);
  }

  /** Largest recorded keyframe ≤ `editUnit`, or null if none recorded at/below it. */
  floor(editUnit: bigint): { editUnit: bigint; byteOffset: bigint } | null {
    const i = this.findIndexFloor(editUnit);
    if (i < 0) return null;
    return { editUnit: this.editUnits[i], byteOffset: this.byteOffsets[i] };
  }

  get size(): number {
    return this.editUnits.length;
  }

  clear(): void {
    this.editUnits = [];
    this.byteOffsets = [];
    this.stride = 1;
  }

  /** Binary search: index of the largest entry whose editUnit ≤ target, or -1. */
  private findIndexFloor(target: bigint): number {
    let lo = 0, hi = this.editUnits.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.editUnits[mid] <= target) { res = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return res;
  }

  /** Drop every other entry and double the stride, halving memory while keeping coverage spread. */
  private decimate(): void {
    const eu: bigint[] = [];
    const bo: bigint[] = [];
    for (let i = 0; i < this.editUnits.length; i += 2) {
      eu.push(this.editUnits[i]);
      bo.push(this.byteOffsets[i]);
    }
    this.editUnits = eu;
    this.byteOffsets = bo;
    this.stride *= 2;
  }
}
