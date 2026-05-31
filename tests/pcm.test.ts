import { describe, it, expect } from 'vitest';
import { decodePcmElements } from '../src/audio/pcm.js';

// Pack a signed 24-bit little-endian sample into 3 bytes.
function s24le(v: number): number[] {
  const u = v < 0 ? v + 0x1000000 : v;
  return [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff];
}
function s16le(v: number): number[] {
  const u = v < 0 ? v + 0x10000 : v;
  return [u & 0xff, (u >> 8) & 0xff];
}
function buf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe('decodePcmElements', () => {
  it('decodes a single interleaved 8-channel 24-bit element (XAVC layout)', () => {
    // One edit unit, one element, 2 sample-frames of 8 channels (blockAlign = 24).
    const frame0 = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(ch => s24le(ch * 0x10000));
    const frame1 = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(ch => s24le(-ch * 0x10000));
    const data = buf([...frame0, ...frame1]);
    const { samples, channelCount } = decodePcmElements(
      [{ editUnit: 0, data }],
      { bitDepth: 24, blockAlign: 24, channelCount: 8 },
    );
    expect(channelCount).toBe(8);
    expect(samples.length).toBe(2 * 8);
    // frame 0, channel 3 = 3*0x10000 / 2^23
    expect(samples[3]).toBeCloseTo((3 * 0x10000) / 8388608, 6);
    // frame 1, channel 5 = -5*0x10000 / 2^23  → index 8 + 5
    expect(samples[8 + 5]).toBeCloseTo((-5 * 0x10000) / 8388608, 6);
  });

  it('interleaves N separate mono 24-bit elements per edit unit (XDCAM layout)', () => {
    // One edit unit, 4 mono elements (blockAlign = 3), 2 samples each.
    const ch0 = buf([...s24le(0x111111), ...s24le(0x222222)]);
    const ch1 = buf([...s24le(0x333333), ...s24le(0x444444)]);
    const ch2 = buf([...s24le(0), ...s24le(0)]);
    const ch3 = buf([...s24le(0), ...s24le(0)]);
    const { samples, channelCount } = decodePcmElements(
      [
        { editUnit: 7, data: ch0 },
        { editUnit: 7, data: ch1 },
        { editUnit: 7, data: ch2 },
        { editUnit: 7, data: ch3 },
      ],
      { bitDepth: 24, blockAlign: 3, channelCount: 1 },
    );
    expect(channelCount).toBe(4);
    expect(samples.length).toBe(2 * 4);
    // interleaved: [s0c0, s0c1, s0c2, s0c3, s1c0, ...]
    expect(samples[0]).toBeCloseTo(0x111111 / 8388608, 6);
    expect(samples[1]).toBeCloseTo(0x333333 / 8388608, 6);
    expect(samples[4]).toBeCloseTo(0x222222 / 8388608, 6); // s1c0
    expect(samples[5]).toBeCloseTo(0x444444 / 8388608, 6); // s1c1
  });

  it('preserves channel order and concatenates across multiple edit units', () => {
    // Two edit units, 2 mono elements each.
    const eu0c0 = buf([...s24le(10)]);
    const eu0c1 = buf([...s24le(20)]);
    const eu1c0 = buf([...s24le(30)]);
    const eu1c1 = buf([...s24le(40)]);
    const { samples, channelCount } = decodePcmElements(
      [
        { editUnit: 0, data: eu0c0 },
        { editUnit: 0, data: eu0c1 },
        { editUnit: 1, data: eu1c0 },
        { editUnit: 1, data: eu1c1 },
      ],
      { bitDepth: 24, blockAlign: 3, channelCount: 1 },
    );
    expect(channelCount).toBe(2);
    expect(Array.from(samples).map(x => Math.round(x * 8388608))).toEqual([10, 20, 30, 40]);
  });

  it('decodes 16-bit PCM correctly (legacy bit depth)', () => {
    const data = buf([...s16le(0x4000), ...s16le(-0x4000)]); // stereo, 1 frame
    const { samples, channelCount } = decodePcmElements(
      [{ editUnit: 0, data }],
      { bitDepth: 16, blockAlign: 4, channelCount: 2 },
    );
    expect(channelCount).toBe(2);
    expect(samples[0]).toBeCloseTo(0x4000 / 32768, 6);
    expect(samples[1]).toBeCloseTo(-0x4000 / 32768, 6);
  });

  it('decodes AES3-wrapped sound (D-10): 4-byte header, 8×32-bit words, sample in bits 4-27', () => {
    // Pack a 24-bit sample into an AES3 32-bit LE word (sample in bits 4-27, low nibble = flags).
    const aes3 = (sample24: number, flags = 0): number[] => {
      const u = (sample24 < 0 ? sample24 + 0x1000000 : sample24) & 0xffffff;
      const word = ((u << 4) | (flags & 0xf)) >>> 0;
      return [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff];
    };
    const header = [0x00, 0x80, 0x07, 0x0f];
    const frame0 = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(ch => aes3(ch * 1000, ch)); // flags vary, ignored
    const frame1 = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(ch => aes3(-ch * 1000));
    const data = buf([...header, ...frame0, ...frame1]);
    const { samples, channelCount } = decodePcmElements(
      [{ editUnit: 0, data, aes3: true }],
      { bitDepth: 24, blockAlign: 0, channelCount: 4 }, // descriptor says 4, element carries 8
    );
    expect(channelCount).toBe(8);
    expect(samples.length).toBe(2 * 8);
    expect(samples[3]).toBeCloseTo((3 * 1000) / 8388608, 6);   // frame0 ch3
    expect(samples[8 + 5]).toBeCloseTo((-5 * 1000) / 8388608, 6); // frame1 ch5
    expect(samples[0]).toBeCloseTo(0, 6);                       // ch0 = 0 regardless of flags
  });

  it('AES3 matches the equivalent 24-bit LE PCM sample (real D-10 word)', () => {
    // Real bytes from D10.mxf ch0: 10 1a fe 0f  → must equal XAVC ch0 a1 e1 ff = 0xffe1a1 (-7775).
    const header = [0x00, 0x80, 0x07, 0x0f];
    const frame = [
      0x10, 0x1a, 0xfe, 0x0f,                       // ch0
      ...Array(7 * 4).fill(0),                       // ch1-7 silent
    ];
    const { samples } = decodePcmElements(
      [{ editUnit: 0, data: buf([...header, ...frame]), aes3: true }],
      { bitDepth: 24, blockAlign: 0, channelCount: 8 },
    );
    expect(Math.round(samples[0] * 8388608)).toBe(-7775); // 0xffe1a1 signed
  });

  it('returns empty for no elements', () => {
    const { samples, channelCount } = decodePcmElements([], { bitDepth: 24, blockAlign: 3, channelCount: 1 });
    expect(samples.length).toBe(0);
    expect(channelCount).toBe(1);
  });
});
