import { describe, it, expect } from 'vitest';
import { ILoader } from '../src/loader/loader.js';
import { CachingLoader, wrapWithSourceCache, SOURCE_CACHE_BLOCK_SIZE } from '../src/loader/caching-loader.js';

const BS = SOURCE_CACHE_BLOCK_SIZE;

/** In-memory loader over a deterministic byte pattern, recording every range read. */
class MemLoader implements ILoader {
  readonly fileSize: Promise<number>;
  readonly reads: Array<{ start: number; end: number; len: number }> = [];
  private aborts = 0;
  constructor(private readonly size: number) {
    this.fileSize = Promise.resolve(size);
  }
  // byte value = offset mod 251 (prime, so any misalignment shows up as a wrong byte).
  private byteAt(i: number): number { return i % 251; }
  async fetchRange(start: number, end: number, _reason?: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    this.reads.push({ start, end, len: end - start + 1 });
    const clampedEnd = Math.min(end, this.size - 1);
    const out = new Uint8Array(Math.max(0, clampedEnd - start + 1));
    for (let i = 0; i < out.length; i++) out[i] = this.byteAt(start + i);
    return out.buffer;
  }
  refreshFileSize(): Promise<number> { return Promise.resolve(this.size); }
  destroy(): void { /* no-op */ }
  get bytesRead(): number { return this.reads.reduce((s, r) => s + r.len, 0); }
}

/** Expected byte pattern, to verify the cache returns exactly the right bytes. */
function expectPattern(buf: ArrayBuffer, start: number): void {
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) {
    if (u[i] !== (start + i) % 251) {
      throw new Error(`byte ${i} (file offset ${start + i}) = ${u[i]}, expected ${(start + i) % 251}`);
    }
  }
}

describe('CachingLoader', () => {
  it('serves an exact repeat read from cache (one inner read total)', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 256 * BS);

    const a = await c.fetchRange(0, BS - 1);
    const b = await c.fetchRange(0, BS - 1);
    expectPattern(a, 0);
    expectPattern(b, 0);
    expect(mem.reads.length).toBe(1); // second read fully cached
    expect(c.getCacheStats().hits).toBe(1);
  });

  it('serves a misaligned sub-range from a cached block without re-fetching', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 256 * BS);

    await c.fetchRange(0, 2 * BS - 1);          // caches blocks 0,1
    const readsAfterFill = mem.reads.length;
    const sub = await c.fetchRange(BS + 1000, BS + 5000); // wholly inside block 1
    expectPattern(sub, BS + 1000);
    expect(mem.reads.length).toBe(readsAfterFill); // no new network read
  });

  it('fetches block-aligned and dedups differently-aligned overlapping reads', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 256 * BS);

    // First read starts mid-block 0, ends mid-block 2 → pulls blocks 0,1,2 (aligned).
    const r1 = await c.fetchRange(500, 2 * BS + 500);
    expectPattern(r1, 500);
    // The aligned fetch covered [0, 3*BS) clamped — blocks 0,1,2 now cached.
    expect(mem.reads[0].start).toBe(0);
    expect(mem.reads[0].end).toBe(3 * BS - 1);

    // A second read on a different alignment, fully within blocks 0..2 → no new read.
    const before = mem.reads.length;
    const r2 = await c.fetchRange(BS - 100, 2 * BS - 100);
    expectPattern(r2, BS - 100);
    expect(mem.reads.length).toBe(before);
  });

  it('coalesces a run of missing blocks into a single inner fetch', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 256 * BS);

    await c.fetchRange(5 * BS, 5 * BS + 10); // cache block 5 only
    mem.reads.length = 0;

    // Request spans blocks 3..7. Block 5 is cached → two missing runs: [3,4] and [6,7].
    const r = await c.fetchRange(3 * BS + 7, 7 * BS + 9);
    expectPattern(r, 3 * BS + 7);
    expect(mem.reads.length).toBe(2);
    expect(mem.reads[0]).toMatchObject({ start: 3 * BS, end: 5 * BS - 1 }); // run [3,4]
    expect(mem.reads[1]).toMatchObject({ start: 6 * BS, end: 8 * BS - 1 }); // run [6,7]
  });

  it('evicts least-recently-used blocks to respect the byte budget', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 3 * BS); // room for 3 blocks

    await c.fetchRange(0, BS - 1); // block 0
    await c.fetchRange(BS, 2 * BS - 1); // block 1
    await c.fetchRange(2 * BS, 3 * BS - 1); // block 2
    expect(c.getCacheStats().blocks).toBe(3);

    await c.fetchRange(3 * BS, 4 * BS - 1); // block 3 → evicts block 0 (LRU)
    expect(c.getCacheStats().blocks).toBe(3);
    expect(c.getCacheStats().cachedBytes).toBeLessThanOrEqual(3 * BS);

    mem.reads.length = 0;
    await c.fetchRange(0, BS - 1); // block 0 was evicted → must re-fetch
    expect(mem.reads.length).toBe(1);
  });

  it('keeps a block warm via LRU touch on a cache hit', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 3 * BS);

    await c.fetchRange(0, BS - 1);       // block 0
    await c.fetchRange(BS, 2 * BS - 1);  // block 1
    await c.fetchRange(2 * BS, 3 * BS - 1); // block 2
    await c.fetchRange(0, BS - 1);       // touch block 0 → now MRU; block 1 is LRU
    await c.fetchRange(3 * BS, 4 * BS - 1); // block 3 → evicts block 1, NOT block 0

    mem.reads.length = 0;
    await c.fetchRange(0, BS - 1); // still cached
    expect(mem.reads.length).toBe(0);
  });

  it('handles a partial final block at EOF', async () => {
    const size = 3 * BS + 12345; // last block is partial
    const mem = new MemLoader(size);
    const c = new CachingLoader(mem, 256 * BS);

    const tail = await c.fetchRange(3 * BS, size - 1);
    expectPattern(tail, 3 * BS);
    expect(tail.byteLength).toBe(12345);

    // Re-read the partial tail from cache.
    const before = mem.reads.length;
    const again = await c.fetchRange(3 * BS, size - 1);
    expectPattern(again, 3 * BS);
    expect(mem.reads.length).toBe(before);
    // The block-aligned fetch was clamped to the file size, not rounded past EOF.
    expect(mem.reads[0].end).toBe(size - 1);
  });

  it('bypasses the cache for a request larger than the whole budget', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 2 * BS);

    const r = await c.fetchRange(0, 5 * BS - 1); // 5 blocks > 2-block budget
    expectPattern(r, 0);
    expect(mem.reads[0]).toMatchObject({ start: 0, end: 5 * BS - 1 }); // passed straight through
    expect(c.getCacheStats().blocks).toBe(0); // nothing cached
  });

  it('propagates an abort signal to the inner loader and caches nothing', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 256 * BS);
    const ac = new AbortController();
    ac.abort();

    await expect(c.fetchRange(0, BS - 1, '', ac.signal)).rejects.toThrow();
    expect(c.getCacheStats().blocks).toBe(0);
  });

  it('delegates getStats / refreshFileSize / fileSize to the inner loader', async () => {
    const mem = new MemLoader(10 * BS);
    const c = new CachingLoader(mem, 256 * BS);
    expect(await c.fileSize).toBe(10 * BS);
    expect(await c.refreshFileSize!()).toBe(10 * BS);
  });
});

describe('wrapWithSourceCache', () => {
  it('returns the inner loader unchanged in live mode', () => {
    const mem = new MemLoader(10 * BS);
    expect(wrapWithSourceCache(mem, 256 * BS, true)).toBe(mem);
  });

  it('returns the inner loader unchanged when the budget is 0 or below one block', () => {
    const mem = new MemLoader(10 * BS);
    expect(wrapWithSourceCache(mem, 0, false)).toBe(mem);
    expect(wrapWithSourceCache(mem, BS - 1, false)).toBe(mem);
  });

  it('wraps with a CachingLoader for a real VOD budget', () => {
    const mem = new MemLoader(10 * BS);
    expect(wrapWithSourceCache(mem, 256 * BS, false)).toBeInstanceOf(CachingLoader);
  });

  it('does not expose refreshFileSize when the inner loader lacks it', () => {
    const noRefresh: ILoader = {
      fileSize: Promise.resolve(BS),
      fetchRange: () => Promise.resolve(new ArrayBuffer(0)),
      destroy: () => { /* no-op */ },
    };
    const c = new CachingLoader(noRefresh, 256 * BS);
    expect(c.refreshFileSize).toBeUndefined();
    expect(c.getStats).toBeUndefined();
  });
});
