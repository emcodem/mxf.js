/**
 * Tests for the index-less ('none') ALL-INTRA byte-percentage seek path:
 *  - essenceEndByte / approxEssenceByte (pure math, src/worker/noindex-intra.ts)
 *  - MxfFile.findPackageStartAtOrAfter (resync + dig forward to the next content package)
 *
 * Together these resolve a seek-target frame to a byte offset and a content-package boundary on a
 * file with no usable index, where the persistent forward reader then plays from. See the 'none'
 * fix plan.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { essenceEndByte, approxEssenceByte } from '../src/worker/noindex-intra.js';
import { MxfFile } from '../src/mxf-file.js';
import type { RandomIndexPackEntry } from '../src/mxf-file.js';
import { LiveSequentialReader } from '../src/essence/essence-extractor.js';
import type { EssenceFrame } from '../src/essence/essence-extractor.js';
import { ILoader } from '../src/loader/loader.js';
import { encodeBerLength } from '../src/core/ber.js';
import { UL_GC_PICTURE_ITEM_PREFIX, UL_GC_SOUND_ITEM_PREFIX, UL_KLV_FILL } from '../src/core/ul.js';

// System Item GC element prefix (bytes [8..11]=0D 01 03 01, byte 12=0x14 → GC system item).
const SYSTEM_ITEM_PREFIX = new Uint8Array([0x06, 0x0e, 0x2b, 0x34, 0x01, 0x02, 0x01, 0x01, 0x0d, 0x01, 0x03, 0x01, 0x14]);

function klv(prefix: Uint8Array, value: Uint8Array): Uint8Array {
  const key = new Uint8Array(16);
  key.set(prefix.subarray(0, 16));
  const len = encodeBerLength(value.length);
  const out = new Uint8Array(16 + len.length + value.length);
  out.set(key, 0);
  out.set(len, 16);
  out.set(value, 16 + len.length);
  return out;
}
const sysKLV = (n = 20) => klv(SYSTEM_ITEM_PREFIX, new Uint8Array(n).fill(0x22));
const picKLV = (n = 40) => klv(UL_GC_PICTURE_ITEM_PREFIX, new Uint8Array(n).fill(0xaa));
const audKLV = (n = 30) => klv(UL_GC_SOUND_ITEM_PREFIX, new Uint8Array(n).fill(0x11));
const fillKLV = (n = 24) => klv(UL_KLV_FILL as unknown as Uint8Array, new Uint8Array(n).fill(0x00));

/** Concatenate parts, returning the buffer plus the absolute start offset of each part. */
function layout(parts: Uint8Array[]): { buf: Uint8Array; offsets: number[] } {
  const offsets: number[] = [];
  let total = 0;
  for (const p of parts) { offsets.push(total); total += p.length; }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return { buf, offsets };
}

class MemLoader implements ILoader {
  readonly fileSize: Promise<number>;
  constructor(private readonly buf: Uint8Array) { this.fileSize = Promise.resolve(buf.length); }
  fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    return Promise.resolve(this.buf.slice(start, end + 1).buffer as ArrayBuffer);
  }
  destroy(): void { /* no-op */ }
}

describe('essenceEndByte', () => {
  it('returns the first footer/index partition (RIP bodySID 0) above the essence start', () => {
    const rip: RandomIndexPackEntry[] = [
      { bodySID: 0, byteOffset: 0n },             // header — below essenceStart, ignored
      { bodySID: 1, byteOffset: 2_000_348n },     // body — bodySID != 0, ignored
      { bodySID: 0, byteOffset: 386_506_129n },   // footer — the answer
    ];
    expect(essenceEndByte(rip, 2_000_504, 388_506_285)).toBe(386_506_129);
  });
  it('falls back to fileSize when no footer entry lies above the essence start', () => {
    const rip: RandomIndexPackEntry[] = [{ bodySID: 1, byteOffset: 2_000_348n }];
    expect(essenceEndByte(rip, 2_000_504, 4_000_000)).toBe(4_000_000);
  });
});

describe('approxEssenceByte', () => {
  it('maps frame 0 to the essence start exactly', () => {
    expect(approxEssenceByte(0, 625, 1000, 2000)).toBe(1000);
  });
  it('maps the final frame to (near) the essence end', () => {
    expect(approxEssenceByte(625, 625, 1000, 2000)).toBe(2000);
  });
  it('maps a midpoint frame proportionally', () => {
    expect(approxEssenceByte(312, 625, 1000, 2000)).toBe(1000 + Math.floor((312 / 625) * 1000));
  });
  it('clamps negative frames and unknown totals to the essence start', () => {
    expect(approxEssenceByte(-5, 625, 1000, 2000)).toBe(1000);
    expect(approxEssenceByte(10, 0, 1000, 2000)).toBe(1000);
  });
});

describe('MxfFile.findPackageStartAtOrAfter', () => {
  // Three packages: [Sys, Pic, Aud] each.
  const parts = [sysKLV(), picKLV(), audKLV(), sysKLV(), picKLV(), audKLV(), sysKLV(), picKLV(), audKLV()];
  const { buf, offsets } = layout(parts);
  const [sys0, , , sys1, , , sys2] = offsets;
  const end = buf.length;
  const mk = () => new MxfFile(new MemLoader(buf));

  it('returns the System Item that starts the package at an exact boundary', async () => {
    expect(await mk().findPackageStartAtOrAfter(sys1, end)).toBe(sys1);
  });

  it('digs forward to the NEXT package start when landing mid-frame', async () => {
    // Land inside package 0's picture element → resync skips its tail (audio) and returns package 1.
    const midPic0 = offsets[1] + 5;
    expect(await mk().findPackageStartAtOrAfter(midPic0, end)).toBe(sys1);
  });

  it('skips KLV Fill before a package', async () => {
    const withFill = layout([fillKLV(), sysKLV(), picKLV(), audKLV()]);
    const f = new MxfFile(new MemLoader(withFill.buf));
    expect(await f.findPackageStartAtOrAfter(0, withFill.buf.length)).toBe(withFill.offsets[1]); // the sys item
  });

  it('returns a bare picture element when no System Item precedes it', async () => {
    const picOnly = layout([picKLV(), picKLV(), picKLV()]);
    const f = new MxfFile(new MemLoader(picOnly.buf));
    expect(await f.findPackageStartAtOrAfter(0, picOnly.buf.length)).toBe(0);
  });

  // Reference the third package so all destructured offsets are exercised by the suite.
  it('resolves the last package boundary too', async () => {
    expect(await mk().findPackageStartAtOrAfter(sys2, end)).toBe(sys2);
  });
});

/**
 * End-to-end regression on a REAL all-intra file forced to indexMode 'none' — drives the exact calls
 * the worker's noIndexIntra branch makes (LiveSequentialReader forward + byte-% reposition via
 * findPackageStartAtOrAfter). Proves: forward play is contiguous (frame 5 ≠ frame 0), and a mid-file
 * seek lands on later content rather than re-reading the opening second (the looping bug).
 */
const REAL = process.env.TEST_NONE_INTRA_FILE ?? 'C:/Temp/mxf.js/1080i25_ARDZDF_HDF02a_AVC-I-100.mxf';

class FsLoader implements ILoader {
  readonly fileSize: Promise<number>;
  private readonly fd: number;
  constructor(path: string) { this.fd = fs.openSync(path, 'r'); this.fileSize = Promise.resolve(fs.fstatSync(this.fd).size); }
  fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    const len = end - start + 1;
    const b = Buffer.alloc(len);
    fs.readSync(this.fd, b, 0, len, start);
    return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }
  destroy(): void { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
}

async function firstVideo(reader: LiveSequentialReader, count: number, fileSize: number): Promise<EssenceFrame[]> {
  const out: EssenceFrame[] = [];
  for await (const f of reader.readForward(count, fileSize)) if (f.trackType === 'video') out.push(f);
  return out;
}
// Whole-frame fingerprint. The first few hundred bytes of consecutive AVC-Intra AUs are near-identical
// (SPS/PPS/AUD + slice-header prefix), so sample across the entire picture payload to tell frames apart.
function fingerprint(data: ArrayBuffer): string {
  const u = new Uint8Array(data);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < u.length; i += 101) { h = (h ^ u[i]) >>> 0; h = Math.imul(h, 16777619) >>> 0; }
  return `${u.length}:${h.toString(16)}`;
}

describe('no-index intra byte-% path on a real file (forced none)', () => {
  const exists = fs.existsSync(REAL);
  (exists ? it : it.skip)('forward play is contiguous and a mid-file seek lands on later content', async () => {
    const loader = new FsLoader(REAL);
    const fileSize = await loader.fileSize;
    const boot = await new MxfFile(loader).open();
    const essStart = Number(boot.essenceStart);
    const essEnd = essenceEndByte(boot.ripEntries, essStart, fileSize);
    const total = Number(boot.metadata.duration);
    expect(total).toBeGreaterThan(50); // a real multi-second clip

    // Forward play: one persistent reader, two consecutive fetches → edit units must advance, not reset.
    const fwd = new LiveSequentialReader(loader, BigInt(essStart), 0n, 25);
    const chunkA = await firstVideo(fwd, 5, fileSize);
    const chunkB = await firstVideo(fwd, 5, fileSize);
    expect(chunkA.map(f => Number(f.editUnit))).toEqual([0, 1, 2, 3, 4]);
    expect(chunkB.map(f => Number(f.editUnit))).toEqual([5, 6, 7, 8, 9]);
    const frame0 = fingerprint(chunkA[0].data);
    expect(fingerprint(chunkB[0].data)).not.toBe(frame0); // frame 5 is different content (no loop)

    // Seek to ~mid-file by byte percentage → dig to the next package → read from there.
    const target = Math.floor(total / 2);
    const approx = approxEssenceByte(target, total, essStart, essEnd);
    const pkg = await new MxfFile(loader).findPackageStartAtOrAfter(approx, essEnd);
    expect(pkg).toBeGreaterThan(essStart);
    const seekReader = new LiveSequentialReader(loader, BigInt(pkg), BigInt(target), 25);
    const seeked = await firstVideo(seekReader, 2, fileSize);
    expect(Number(seeked[0].editUnit)).toBe(target);          // labeled as the seek target frame
    expect(fingerprint(seeked[0].data)).not.toBe(frame0);            // NOT the looped opening second
  });
});
