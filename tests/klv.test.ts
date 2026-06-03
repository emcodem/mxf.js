import { describe, it, expect } from 'vitest';
import { readKLV, KLVIterator } from '../src/core/klv.js';

function makeKLV(keyByte: number, value: Uint8Array): Uint8Array {
  const key = new Uint8Array(16);
  key[0] = 0x06; key[1] = 0x0e; key[2] = 0x2b; key[3] = 0x34;
  key[4] = keyByte;
  const buf = new Uint8Array(16 + 1 + value.length);
  buf.set(key, 0);
  buf[16] = value.length; // short BER
  buf.set(value, 17);
  return buf;
}

describe('readKLV', () => {
  it('parses a simple KLV with short BER length', () => {
    const value = new Uint8Array([0x01, 0x02, 0x03]);
    const buf = makeKLV(0x01, value).buffer;
    const pkt = readKLV(buf, 0);
    expect(pkt.valueLength).toBe(3);
    expect(pkt.valueOffset).toBe(17);
    expect(pkt.totalLength).toBe(20);
    expect(Array.from(pkt.key.slice(0, 4))).toEqual([0x06, 0x0e, 0x2b, 0x34]);
  });

  it('parses KLV with long BER length (0x82)', () => {
    const value = new Uint8Array(300).fill(0xab);
    const key = new Uint8Array(16);
    key[0] = 0x06; key[1] = 0x0e; key[2] = 0x2b; key[3] = 0x34;
    const ber = new Uint8Array([0x82, 0x01, 0x2c]); // 0x012c = 300
    const buf = new Uint8Array(16 + 3 + 300);
    buf.set(key, 0);
    buf.set(ber, 16);
    buf.set(value, 19);

    const pkt = readKLV(buf.buffer, 0);
    expect(pkt.valueLength).toBe(300);
    expect(pkt.valueOffset).toBe(19);
    expect(pkt.totalLength).toBe(16 + 3 + 300);
  });

  it('throws when value extends beyond buffer', () => {
    const key = new Uint8Array(16).fill(0x06);
    const buf = new Uint8Array([...key, 0x10]); // says length=16 but no value bytes
    expect(() => readKLV(buf.buffer, 0)).toThrow();
  });
});

describe('KLVIterator', () => {
  it('iterates multiple KLVs', () => {
    const a = makeKLV(0x01, new Uint8Array([0xaa, 0xbb]));
    const b = makeKLV(0x02, new Uint8Array([0xcc]));
    const buf = new Uint8Array(a.length + b.length);
    buf.set(a, 0);
    buf.set(b, a.length);

    const iter = new KLVIterator(buf.buffer);
    const pkt1 = iter.next()!;
    expect(pkt1.valueLength).toBe(2);
    const pkt2 = iter.next()!;
    expect(pkt2.valueLength).toBe(1);
    expect(iter.next()).toBeNull();
  });

  it('resync recovers the next valid KLV after a malformed one', () => {
    // a (valid) | corrupt KLV claiming a huge length | b (valid). next() returns null on the
    // corrupt packet; resync() must skip it and land on b.
    const a = makeKLV(0x01, new Uint8Array([0xaa]));
    const corruptKey = new Uint8Array(16);
    corruptKey[0] = 0x06; corruptKey[1] = 0x0e; corruptKey[2] = 0x2b; corruptKey[3] = 0x34;
    const corrupt = new Uint8Array([...corruptKey, 0x84, 0x7f, 0xff, 0xff, 0xff]); // length ~2GB, no value
    const b = makeKLV(0x02, new Uint8Array([0xbb, 0xcc]));
    const buf = new Uint8Array(a.length + corrupt.length + b.length);
    buf.set(a, 0);
    buf.set(corrupt, a.length);
    buf.set(b, a.length + corrupt.length);

    const iter = new KLVIterator(buf.buffer);
    expect(iter.next()!.valueLength).toBe(1);   // a
    expect(iter.next()).toBeNull();              // corrupt → null, pos not advanced
    expect(iter.resync()).toBe(true);            // skip forward to b
    const pktB = iter.next()!;
    expect(pktB.valueLength).toBe(2);            // recovered b
    expect(pktB.key[4]).toBe(0x02);
  });

  it('resync returns false when no further valid key exists', () => {
    const a = makeKLV(0x01, new Uint8Array([0xaa]));
    const trailing = new Uint8Array([0x06, 0x0e, 0x2b, 0x34, 0x00]); // looks like a key start, too short
    const buf = new Uint8Array(a.length + trailing.length);
    buf.set(a, 0);
    buf.set(trailing, a.length);
    const iter = new KLVIterator(buf.buffer);
    iter.next(); // a
    expect(iter.resync()).toBe(false);
  });

  it('skipRunIn finds 06 0E 2B 34 key after garbage bytes', () => {
    const garbage = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0xff, 0xfe]);
    const klv = makeKLV(0x01, new Uint8Array([0x42]));
    const buf = new Uint8Array(garbage.length + klv.length);
    buf.set(garbage, 0);
    buf.set(klv, garbage.length);
    const offset = KLVIterator.skipRunIn(buf.buffer);
    expect(offset).toBe(garbage.length);
  });
});
