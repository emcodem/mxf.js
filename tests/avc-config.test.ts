import { describe, it, expect } from 'vitest';
import { buildAVCDecoderConfigRecord } from '../src/essence/avc-tools.js';
import { avcC } from '../src/remuxer/mp4-boxes.js';

// Minimal NALUs: byte 0 = nal header, bytes 1-3 used as profile/compat/level for SPS.
const sps = new Uint8Array([0x67, 0x64, 0x00, 0x29, 0xaa, 0xbb]);
const pps0 = new Uint8Array([0x68, 0x11, 0x22]);
const pps1 = new Uint8Array([0x68, 0x33, 0x44, 0x55]);

describe('buildAVCDecoderConfigRecord — multiple PPS', () => {
  it('emits every PPS, not just the first', () => {
    const rec = buildAVCDecoderConfigRecord([sps], [pps0, pps1]);
    // profile/compat/level mirror sps[1..3]
    expect([rec[1], rec[2], rec[3]]).toEqual([0x64, 0x00, 0x29]);
    expect(rec[4]).toBe(0xff);                 // lengthSizeMinusOne = 3
    expect(rec[5]).toBe(0xe1);                 // 0xe0 | numSPS(1)

    // After the single SPS (2-byte len + 6 bytes), the numPPS byte must be 2.
    const numPpsOffset = 6 + 2 + sps.length;
    expect(rec[numPpsOffset]).toBe(2);

    // Both PPS payloads must appear verbatim in the record.
    const hex = Array.from(rec).join(',');
    expect(hex).toContain(Array.from(pps0).join(','));
    expect(hex).toContain(Array.from(pps1).join(','));
  });

  it('throws when given no SPS or no PPS', () => {
    expect(() => buildAVCDecoderConfigRecord([], [pps0])).toThrow();
    expect(() => buildAVCDecoderConfigRecord([sps], [])).toThrow();
  });
});

describe('avcC box — multiple PPS', () => {
  it('declares numPPS = 2 and is a well-formed box', () => {
    const box = avcC([sps], [pps0, pps1]);
    // box: 4-byte size + 'avcC' + record. Record starts at offset 8.
    expect(String.fromCharCode(box[4], box[5], box[6], box[7])).toBe('avcC');
    const rec = box.subarray(8);
    expect(rec[5]).toBe(0xe1);                 // numSPS = 1
    const numPpsOffset = 6 + 2 + sps.length;
    expect(rec[numPpsOffset]).toBe(2);         // numPPS = 2
    // Box size field equals total length.
    const size = (box[0] << 24) | (box[1] << 16) | (box[2] << 8) | box[3];
    expect(size).toBe(box.length);
  });
});
