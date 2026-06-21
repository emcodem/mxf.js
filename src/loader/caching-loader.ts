import { ILoader, LoaderStats } from './loader.js';

/**
 * Block granularity for the source cache. Reads in the pipeline aren't aligned the same way each
 * time — index reads are per-edit-unit ranges, the no-index path uses rolling 4 MB windows from
 * scan-relative starts, and a no-index seek starts that grid at an arbitrary byte. Caching on a
 * FIXED global block grid (rather than on the exact request range) lets any of those reads reuse
 * the same blocks regardless of alignment, so backward seeks / loops / scrub-revisits become
 * network-free. 1 MB balances dedup granularity against per-block bookkeeping.
 */
export const SOURCE_CACHE_BLOCK_SIZE = 1024 * 1024;

/**
 * Wrap a loader with a block-aligned LRU cache of raw source bytes, unless caching is disabled.
 *
 * Returns the inner loader UNCHANGED when:
 * - `live` — a growing recording. Live reads are forward-only with little revisit, and a
 *   preallocated/zero-filled recording returns complete-looking blocks ahead of the write frontier
 *   whose bytes will still change; the byte-level cache can't see that frontier (only the KLV walk
 *   can), so caching live is unsafe for negligible benefit. (Future: cache only regions provably
 *   below a stable frontier.)
 * - `maxBytes` is 0 / too small to hold even one block — nothing to gain.
 */
export function wrapWithSourceCache(inner: ILoader, maxBytes: number, live: boolean): ILoader {
  if (live || !maxBytes || maxBytes < SOURCE_CACHE_BLOCK_SIZE) return inner;
  return new CachingLoader(inner, maxBytes);
}

/**
 * An {@link ILoader} that fronts another loader with a fixed-block LRU cache of raw source bytes.
 * A `fetchRange` is served by assembling cached blocks and fetching only the runs of missing blocks
 * (each missing run coalesced into ONE inner read, fetched block-aligned so the cached blocks stay
 * whole and reusable by differently-aligned reads). It can never increase network traffic beyond
 * rounding each genuine miss out to its block boundaries — which, in sequential playback, is just
 * useful prefetch of the bytes the next window will want.
 *
 * Append-only safety: already-written file bytes are immutable, so a fully-populated cached block
 * stays valid forever. This loader is never used for live/growing sources (see wrapWithSourceCache),
 * so the growing-tail / zero-frontier hazards don't apply here.
 */
export class CachingLoader implements ILoader {
  readonly fileSize: Promise<number>;

  // blockIndex → that block's bytes. Map insertion order IS the LRU order: least-recently-used at
  // the front, most-recently-used at the back. A cache hit re-inserts to move the block to the back.
  private readonly blocks = new Map<number, Uint8Array>();
  private cachedBytes = 0;

  private hits = 0;
  private misses = 0;

  // Conditionally-present passthroughs (declared optional to honour ILoader; assigned in the
  // constructor only when the inner loader actually implements them).
  getStats?: () => LoaderStats;
  refreshFileSize?: () => Promise<number>;

  constructor(private readonly inner: ILoader, private readonly maxBytes: number) {
    this.fileSize = inner.fileSize;
    if (inner.getStats) this.getStats = () => inner.getStats!();
    if (inner.refreshFileSize) this.refreshFileSize = () => inner.refreshFileSize!();
  }

  /** Cache hit/miss counts + current fill, for debugging / a stats display. */
  getCacheStats(): { hits: number; misses: number; cachedBytes: number; maxBytes: number; blocks: number } {
    return { hits: this.hits, misses: this.misses, cachedBytes: this.cachedBytes, maxBytes: this.maxBytes, blocks: this.blocks.size };
  }

  async fetchRange(start: number, end: number, reason = '', signal?: AbortSignal): Promise<ArrayBuffer> {
    const len = end - start + 1;
    if (len <= 0) return new ArrayBuffer(0);

    // A request that can't fit the whole budget bypasses the cache: caching it would evict
    // everything and likely itself, thrashing for no benefit. Serve it straight from the source.
    if (len > this.maxBytes) return this.inner.fetchRange(start, end, reason, signal);

    const fileSize = await this.fileSize;
    const firstBlock = Math.floor(start / SOURCE_CACHE_BLOCK_SIZE);
    const lastBlock = Math.floor(end / SOURCE_CACHE_BLOCK_SIZE);

    const out = new Uint8Array(len);

    let b = firstBlock;
    while (b <= lastBlock) {
      const cached = this.touch(b);
      if (cached) {
        this.hits++;
        this.copyBlockInto(out, b, cached, start, end);
        b++;
        continue;
      }

      // Coalesce a run of consecutive missing blocks into a single block-aligned inner read.
      let runEnd = b; // first cached-or-past-last block after the missing run
      while (runEnd <= lastBlock && !this.blocks.has(runEnd)) runEnd++;
      this.misses += runEnd - b;

      const runStartByte = b * SOURCE_CACHE_BLOCK_SIZE;
      const runEndByteExcl = Math.min(runEnd * SOURCE_CACHE_BLOCK_SIZE, fileSize);
      const fetched = new Uint8Array(
        await this.inner.fetchRange(runStartByte, runEndByteExcl - 1, reason, signal),
      );

      for (let bi = b; bi < runEnd; bi++) {
        const blockStartByte = bi * SOURCE_CACHE_BLOCK_SIZE;
        const offInFetched = blockStartByte - runStartByte;
        const blockLen = Math.min(SOURCE_CACHE_BLOCK_SIZE, fileSize - blockStartByte);
        if (blockLen > 0 && offInFetched + blockLen <= fetched.length) {
          // Whole block present in the read → cache it (a copy, so the big fetched buffer is freed).
          const blockBytes = fetched.slice(offInFetched, offInFetched + blockLen);
          this.store(bi, blockBytes);
          this.copyBlockInto(out, bi, blockBytes, start, end);
        } else if (offInFetched < fetched.length) {
          // Short/truncated read for this block — copy what overlaps, but don't cache a partial block.
          this.copyBlockIntoRaw(out, blockStartByte, fetched.subarray(offInFetched), start, end);
        }
      }
      b = runEnd;
    }

    return out.buffer as ArrayBuffer;
  }

  destroy(): void {
    this.blocks.clear();
    this.cachedBytes = 0;
    this.inner.destroy();
  }

  /** Look up a block and, on a hit, mark it most-recently-used (delete + re-insert at the back). */
  private touch(blockIndex: number): Uint8Array | undefined {
    const block = this.blocks.get(blockIndex);
    if (block === undefined) return undefined;
    this.blocks.delete(blockIndex);
    this.blocks.set(blockIndex, block);
    return block;
  }

  /** Insert/replace a block as most-recently-used, then evict LRU blocks until within budget. */
  private store(blockIndex: number, bytes: Uint8Array): void {
    const existing = this.blocks.get(blockIndex);
    if (existing) { this.cachedBytes -= existing.byteLength; this.blocks.delete(blockIndex); }
    this.blocks.set(blockIndex, bytes);
    this.cachedBytes += bytes.byteLength;

    // Evict from the front (least-recently-used). Keep at least the block we just added.
    while (this.cachedBytes > this.maxBytes && this.blocks.size > 1) {
      const oldest = this.blocks.keys().next().value as number;
      if (oldest === blockIndex) break;
      const evicted = this.blocks.get(oldest)!;
      this.blocks.delete(oldest);
      this.cachedBytes -= evicted.byteLength;
    }
  }

  private copyBlockInto(out: Uint8Array, blockIndex: number, block: Uint8Array, reqStart: number, reqEnd: number): void {
    this.copyBlockIntoRaw(out, blockIndex * SOURCE_CACHE_BLOCK_SIZE, block, reqStart, reqEnd);
  }

  /** Copy the part of a block that overlaps [reqStart, reqEnd] into `out` (indexed from reqStart). */
  private copyBlockIntoRaw(out: Uint8Array, blockStartByte: number, block: Uint8Array, reqStart: number, reqEnd: number): void {
    const blockEndByte = blockStartByte + block.length - 1;
    const from = Math.max(reqStart, blockStartByte);
    const to = Math.min(reqEnd, blockEndByte);
    if (to < from) return;
    const srcOff = from - blockStartByte;
    const dstOff = from - reqStart;
    out.set(block.subarray(srcOff, srcOff + (to - from + 1)), dstOff);
  }
}
