import { describe, it, expect } from 'vitest';
import { EssenceExtractor } from '../src/essence/essence-extractor.js';
import type { EssenceFrame } from '../src/essence/essence-extractor.js';
import { MxfBootstrap } from '../src/mxf-file.js';
import { ILoader } from '../src/loader/loader.js';
import { encodeBerLength } from '../src/core/ber.js';
import { UL_GC_PICTURE_ITEM_PREFIX, UL_GC_SOUND_ITEM_PREFIX } from '../src/core/ul.js';

// --- helpers to build a synthetic essence KLV stream -------------------------------------------

function klv(prefix: Uint8Array, value: Uint8Array): Uint8Array {
  const key = new Uint8Array(16);
  key.set(prefix.subarray(0, 16)); // 13-byte prefix; remaining bytes stay 0
  const len = encodeBerLength(value.length);
  const out = new Uint8Array(16 + len.length + value.length);
  out.set(key, 0);
  out.set(len, 16);
  out.set(value, 16 + len.length);
  return out;
}

function videoKLV(size: number, fill = 0xaa): Uint8Array {
  return klv(UL_GC_PICTURE_ITEM_PREFIX, new Uint8Array(size).fill(fill));
}
function audioKLV(size: number, fill = 0x11): Uint8Array {
  return klv(UL_GC_SOUND_ITEM_PREFIX, new Uint8Array(size).fill(fill));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** In-memory loader recording every range read so we can assert reads stay bounded. */
class MemLoader implements ILoader {
  readonly fileSize: Promise<number>;
  readonly reads: Array<{ start: number; end: number; len: number }> = [];
  constructor(private readonly buf: Uint8Array) {
    this.fileSize = Promise.resolve(buf.length);
  }
  fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    this.reads.push({ start, end, len: end - start + 1 });
    return Promise.resolve(this.buf.slice(start, end + 1).buffer as ArrayBuffer);
  }
  destroy(): void { /* no-op */ }
  get maxRead(): number { return this.reads.reduce((m, r) => Math.max(m, r.len), 0); }
}

function noIndexBootstrap(): MxfBootstrap {
  return {
    indexSegments: [],
    essenceStart: 0n,
    essenceBodySID: 0,
    indexMode: 'none',
  } as unknown as MxfBootstrap;
}

async function collect(gen: AsyncGenerator<EssenceFrame>) {
  const out: Array<{ trackType: string; editUnit: bigint; size: number }> = [];
  for await (const f of gen) out.push({ trackType: f.trackType, editUnit: f.editUnit, size: f.data.byteLength });
  return out;
}

// --- tests --------------------------------------------------------------------------------------

describe('EssenceExtractor sequential (no-index) reader', () => {
  it('yields the requested number of video frames with correct edit units', async () => {
    // 4 edit units, each: video KLV then audio KLV.
    const stream = concat([
      videoKLV(64), audioKLV(32),
      videoKLV(64), audioKLV(32),
      videoKLV(64), audioKLV(32),
      videoKLV(64), audioKLV(32),
    ]);
    const loader = new MemLoader(stream);
    const ex = new EssenceExtractor(loader, noIndexBootstrap());

    const frames = await collect(ex.fetchFrames(0n, 4));
    const video = frames.filter(f => f.trackType === 'video');
    expect(video.map(v => Number(v.editUnit))).toEqual([0, 1, 2, 3]);
    expect(frames.filter(f => f.trackType === 'audio').map(a => Number(a.editUnit))).toEqual([0, 1, 2, 3]);
  });

  it('stops after frameCount video frames', async () => {
    const stream = concat([
      videoKLV(64), audioKLV(32),
      videoKLV(64), audioKLV(32),
      videoKLV(64), audioKLV(32),
    ]);
    const ex = new EssenceExtractor(new MemLoader(stream), noIndexBootstrap());
    const video = (await collect(ex.fetchFrames(0n, 2))).filter(f => f.trackType === 'video');
    expect(video.length).toBe(2);
    expect(video.map(v => Number(v.editUnit))).toEqual([0, 1]);
  });

  it('stops at EOF when fewer frames exist than requested', async () => {
    const stream = concat([videoKLV(64), audioKLV(32), videoKLV(64), audioKLV(32)]);
    const ex = new EssenceExtractor(new MemLoader(stream), noIndexBootstrap());
    const video = (await collect(ex.fetchFrames(0n, 10))).filter(f => f.trackType === 'video');
    expect(video.length).toBe(2);
  });

  it('reads in bounded windows across a multi-MB stream (no whole-file slurp)', async () => {
    // ~6.5 MB total with 1.3 MB video frames so a 4 MB read window splits frames → exercises carry.
    const FRAME = 1_300_000;
    const stream = concat([
      videoKLV(FRAME), audioKLV(1000),
      videoKLV(FRAME), audioKLV(1000),
      videoKLV(FRAME), audioKLV(1000),
      videoKLV(FRAME), audioKLV(1000),
      videoKLV(FRAME), audioKLV(1000),
    ]);
    const loader = new MemLoader(stream);
    const ex = new EssenceExtractor(loader, noIndexBootstrap());

    const video = (await collect(ex.fetchFrames(0n, 5))).filter(f => f.trackType === 'video');
    expect(video.map(v => Number(v.editUnit))).toEqual([0, 1, 2, 3, 4]);
    expect(video.every(v => v.size === FRAME)).toBe(true);
    // Multiple windowed reads, and no single read approached the whole-file 1.5 GB old cap.
    expect(loader.reads.length).toBeGreaterThan(1);
    expect(loader.maxRead).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('handles a single frame larger than the base window (adaptive grow)', async () => {
    // One 5 MB video frame > the 4 MB base window → the reader must grow to read it whole.
    const BIG = 5_000_000;
    const stream = concat([videoKLV(BIG), audioKLV(1000), videoKLV(64), audioKLV(32)]);
    const loader = new MemLoader(stream);
    const ex = new EssenceExtractor(loader, noIndexBootstrap());

    const frames = await collect(ex.fetchFrames(0n, 2));
    const video = frames.filter(f => f.trackType === 'video');
    expect(video.length).toBe(2);
    expect(video[0].size).toBe(BIG);
    expect(video[1].size).toBe(64);
    expect(loader.maxRead).toBeLessThanOrEqual(64 * 1024 * 1024); // never the whole-file slurp
  });
});
