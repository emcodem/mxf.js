/**
 * BitBuffer start-code scanning must never read past `byteLength`. write() compacts with copyWithin()
 * and reset() only zeroes byteLength, so the bytes behind the valid data are stale leftovers; a
 * valid tail of `00 00` followed by stale `01 xx` used to produce a phantom start code (seen as
 * phantom slice rows far beyond the picture height on real XDCAM HD422 pictures with zero stuffing).
 */
import { describe, it, expect } from 'vitest';
import { BitBuffer } from '../src/codec/mpeg2-decoder.js';

const u8 = (...b: number[]) => Uint8Array.from(b);

/** Leave `stale` behind the valid data: write it, consume it, then write `valid` (shorter). */
function withStaleTail(valid: Uint8Array, stale: Uint8Array, viaReset: boolean): BitBuffer {
  const b = new BitBuffer(64);
  b.write(stale);
  if (viaReset) b.reset();
  else b.index = stale.length << 3; // everything consumed → next write() compacts
  b.write(valid);
  return b;
}

describe('BitBuffer.findNextStartCode', () => {
  // Stale bytes 01 7D sit at offsets 10..11, right behind a 10-byte valid tail ending in 00 00.
  const stale = u8(0, 0, 1, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x01, 0x7d, 0x77, 0x88, 0x99, 0xaa);
  const valid = u8(0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a, 0x00, 0x00);

  it('does not return a phantom start code from stale bytes after write() compaction', () => {
    const b = withStaleTail(valid, stale, false);
    expect(b.findNextStartCode()).toBe(-1);
    expect(b.index).toBe(b.byteLength << 3);
  });

  it('does not return a phantom start code from stale bytes after reset()', () => {
    const b = withStaleTail(valid, stale, true);
    expect(b.findNextStartCode()).toBe(-1);
  });

  it('still finds a start code occupying exactly the last 4 valid bytes', () => {
    const b = new BitBuffer(64);
    b.write(u8(0xab, 0xcd, 0x00, 0x00, 0x01, 0x05));
    expect(b.findNextStartCode()).toBe(0x05);
    expect(b.index).toBe(6 << 3);
  });

  it('finds consecutive start codes', () => {
    const b = new BitBuffer(64);
    b.write(u8(0x00, 0x00, 0x01, 0xb3, 0x12, 0x00, 0x00, 0x01, 0x00));
    expect(b.findNextStartCode()).toBe(0xb3);
    expect(b.findNextStartCode()).toBe(0x00);
    expect(b.findNextStartCode()).toBe(-1);
  });
});

describe('BitBuffer.nextBytesAreStartCode', () => {
  it('is true at the end of the buffer', () => {
    const b = new BitBuffer(64);
    b.write(u8(0xaa, 0xbb));
    b.index = 2 << 3;
    expect(b.nextBytesAreStartCode()).toBe(true);
  });

  it('is true for a real start code', () => {
    const b = new BitBuffer(64);
    b.write(u8(0xaa, 0x00, 0x00, 0x01, 0x05));
    b.index = 1 << 3;
    expect(b.nextBytesAreStartCode()).toBe(true);
  });

  it('is false when the last valid byte is 00 and stale bytes behind it read 00 01', () => {
    // Valid: aa bb 00 (3 bytes); stale behind: 00 01 → must not be read as a start code.
    const b = withStaleTail(u8(0xaa, 0xbb, 0x00), u8(0x11, 0x22, 0x33, 0x00, 0x01, 0x99), false);
    b.index = 2 << 3;
    expect(b.nextBytesAreStartCode()).toBe(false);
  });

  it('is false (keep decoding) with one or two valid bytes left that cannot hold a start code', () => {
    const b = new BitBuffer(64);
    b.write(u8(0xaa, 0x00, 0x00));
    b.index = 1 << 3;
    expect(b.nextBytesAreStartCode()).toBe(false);
  });
});
