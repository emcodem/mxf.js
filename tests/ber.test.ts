import { describe, it, expect } from 'vitest';
import { decodeBerLength, encodeBerLength } from '../src/core/ber.js';

describe('BER length decode', () => {
  it('decodes short form (single byte)', () => {
    const buf = new Uint8Array([0x42]).buffer;
    const view = new DataView(buf);
    expect(decodeBerLength(view, 0)).toEqual({ length: 0x42, bytesRead: 1 });
  });

  it('decodes short form zero', () => {
    const buf = new Uint8Array([0x00]).buffer;
    const view = new DataView(buf);
    expect(decodeBerLength(view, 0)).toEqual({ length: 0, bytesRead: 1 });
  });

  it('decodes long form 1-byte count (0x81)', () => {
    const buf = new Uint8Array([0x81, 0xff]).buffer;
    const view = new DataView(buf);
    expect(decodeBerLength(view, 0)).toEqual({ length: 255, bytesRead: 2 });
  });

  it('decodes long form 2-byte count (0x82)', () => {
    const buf = new Uint8Array([0x82, 0x01, 0x00]).buffer;
    const view = new DataView(buf);
    expect(decodeBerLength(view, 0)).toEqual({ length: 256, bytesRead: 3 });
  });

  it('decodes long form 4-byte count (0x84)', () => {
    const buf = new Uint8Array([0x84, 0x00, 0x01, 0x86, 0xa0]).buffer;
    const view = new DataView(buf);
    expect(decodeBerLength(view, 0)).toEqual({ length: 100000, bytesRead: 5 });
  });

  it('reads at non-zero offset', () => {
    const buf = new Uint8Array([0x00, 0x81, 0x80]).buffer;
    const view = new DataView(buf);
    expect(decodeBerLength(view, 1)).toEqual({ length: 128, bytesRead: 2 });
  });
});

describe('BER length encode', () => {
  it('encodes short form', () => {
    expect(Array.from(encodeBerLength(0))).toEqual([0]);
    expect(Array.from(encodeBerLength(127))).toEqual([127]);
  });

  it('encodes 1-byte long form', () => {
    expect(Array.from(encodeBerLength(128))).toEqual([0x81, 0x80]);
    expect(Array.from(encodeBerLength(255))).toEqual([0x81, 0xff]);
  });

  it('encodes 2-byte long form', () => {
    expect(Array.from(encodeBerLength(256))).toEqual([0x82, 0x01, 0x00]);
  });

  it('round-trips', () => {
    const lengths = [0, 1, 127, 128, 255, 256, 65535, 100000];
    for (const len of lengths) {
      const encoded = encodeBerLength(len);
      const padded = new Uint8Array(encoded.length + 2);
      padded.set(encoded, 0);
      const view = new DataView(padded.buffer);
      const decoded = decodeBerLength(view, 0);
      expect(decoded.length).toBe(len);
      expect(decoded.bytesRead).toBe(encoded.length);
    }
  });
});
