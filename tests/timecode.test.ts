import { describe, it, expect } from 'vitest';
import {
  frameCountToTimecode,
  timecodeToFrameCount,
  formatTimecode,
  decodeSmpte12mBcd,
  parseSystemItemTimecode,
} from '../src/parser/timecode.js';

describe('frameCountToTimecode / timecodeToFrameCount (non-drop)', () => {
  it('round-trips at base 25', () => {
    for (const fc of [0, 1, 24, 25, 26, 1500, 90000, 1234567]) {
      const tc = frameCountToTimecode(fc, 25, false);
      expect(timecodeToFrameCount(tc)).toBe(fc);
    }
  });

  it('computes known values at base 25', () => {
    expect(formatTimecode(frameCountToTimecode(0, 25, false))).toBe('00:00:00:00');
    expect(formatTimecode(frameCountToTimecode(25, 25, false))).toBe('00:00:01:00');
    expect(formatTimecode(frameCountToTimecode(1500, 25, false))).toBe('00:01:00:00');
    expect(formatTimecode(frameCountToTimecode(90000, 25, false))).toBe('01:00:00:00');
  });

  it('non-drop base 30 uses ":" separator', () => {
    expect(formatTimecode(frameCountToTimecode(31, 30, false))).toBe('00:00:01:01');
  });
});

describe('drop-frame (base 30 / 29.97)', () => {
  // Canonical reference points for NTSC drop-frame.
  it('matches known frame-number → timecode mappings', () => {
    expect(formatTimecode(frameCountToTimecode(1798, 30, true))).toBe('00:00:59;28');
    expect(formatTimecode(frameCountToTimecode(1799, 30, true))).toBe('00:00:59;29');
    expect(formatTimecode(frameCountToTimecode(1800, 30, true))).toBe('00:01:00;02'); // frames 0,1 dropped
    expect(formatTimecode(frameCountToTimecode(17982, 30, true))).toBe('00:10:00;00'); // no drop on 10th min
  });

  it('round-trips across minute / ten-minute boundaries', () => {
    for (const fc of [0, 1797, 1798, 1799, 1800, 1801, 17981, 17982, 17983, 107892]) {
      const tc = frameCountToTimecode(fc, 30, true);
      expect(timecodeToFrameCount(tc)).toBe(fc);
    }
  });

  it('uses ";" separator', () => {
    expect(formatTimecode(frameCountToTimecode(1800, 30, true))).toContain(';');
  });
});

describe('decodeSmpte12mBcd', () => {
  it('decodes a BCD word', () => {
    // 10:20:30:15, no flags
    const tc = decodeSmpte12mBcd(new Uint8Array([0x15, 0x30, 0x20, 0x10]), 25)!;
    expect(tc).toMatchObject({ hours: 10, minutes: 20, seconds: 30, frames: 15, dropFrame: false, base: 25 });
  });

  it('reads the drop-frame flag (bit 6 of the frames byte)', () => {
    const tc = decodeSmpte12mBcd(new Uint8Array([0x40 | 0x02, 0x00, 0x00, 0x00]), 30)!;
    expect(tc.dropFrame).toBe(true);
    expect(tc.frames).toBe(2);
  });

  it('masks the high flag bits in tens nibbles', () => {
    // frames byte 0xD5: colour-frame(0x80)+drop(0x40)+tens(0x10)+units(5) → 15, drop
    const tc = decodeSmpte12mBcd(new Uint8Array([0xd5, 0x00, 0x00, 0x00]))!;
    expect(tc.frames).toBe(15);
    expect(tc.dropFrame).toBe(true);
  });
});

describe('parseSystemItemTimecode', () => {
  it('extracts the SMPTE 12M timecode at the standard user-timestamp offset (40)', () => {
    const value = new Uint8Array(49);
    value[40] = 0x81;             // timestamp coding type
    value[41] = 0x15;             // frames 15
    value[42] = 0x30;             // seconds 30
    value[43] = 0x20;             // minutes 20
    value[44] = 0x10;             // hours 10
    const tc = parseSystemItemTimecode(value, 25)!;
    expect(formatTimecode(tc)).toBe('10:20:30:15');
    expect(tc.base).toBe(25);
  });

  it('returns null for an unrecognised / out-of-range layout', () => {
    const value = new Uint8Array(20).fill(0xff); // no valid timestamp; bytes out of BCD range
    expect(parseSystemItemTimecode(value, 25)).toBeNull();
  });

  it('picks the User Date (later 0x81), not a constant Creation stamp or trailing zeros', () => {
    // Two 0x81-marked timestamps: Creation @23 = 00:00:00:00 (constant), User @40 = 01:00:00:00.
    // A naive "first valid offset" parser would freeze on the creation stamp / zero padding.
    const value = new Uint8Array(49);
    value[23] = 0x81;                         // creation timestamp coding byte (tc bytes all 0)
    value[40] = 0x81; value[44] = 0x01;       // user timestamp: hours = 01 → 01:00:00:00
    expect(formatTimecode(parseSystemItemTimecode(value, 25)!)).toBe('01:00:00:00');
  });

  it('masks the 50p/59.94p field flag (0x80 in the hours byte) so paired frames share a TC', () => {
    // XAVC-L 1080p50: TC counts at 25 fps; the 2nd frame of each pair sets bit 7 of the hours byte.
    const fieldA = new Uint8Array(49); fieldA[40] = 0x81; fieldA[41] = 0x05;             // frames 05
    const fieldB = new Uint8Array(49); fieldB[40] = 0x81; fieldB[41] = 0x05; fieldB[44] = 0x80; // +field flag
    expect(formatTimecode(parseSystemItemTimecode(fieldA, 50)!)).toBe('00:00:00:05');
    expect(formatTimecode(parseSystemItemTimecode(fieldB, 50)!)).toBe('00:00:00:05');
  });
});
