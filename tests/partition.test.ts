import { describe, it, expect } from 'vitest';
import { parsePartitionPack } from '../src/parser/partition.js';
import { UL_HEADER_PARTITION_CLOSED } from '../src/core/ul.js';
import { encodeBerLength } from '../src/core/ber.js';

// Build a Partition Pack KLV. `ecCount`/`ecItemLen` and the number of real container ULs are
// independently controllable so we can exercise the corrupt-count guard.
function buildPP(ecCount: number, ecItemLen: number, containers: number): ArrayBuffer {
  const FIXED = 80; // bytes before the essence-container batch (versions..operationalPattern)
  const valueLen = FIXED + 8 + containers * ecItemLen;
  const ber = encodeBerLength(valueLen);
  const buf = new Uint8Array(16 + ber.length + valueLen);
  buf.set(UL_HEADER_PARTITION_CLOSED, 0);
  buf.set(ber, 16);
  const v = new DataView(buf.buffer, 16 + ber.length);
  v.setUint32(FIXED, ecCount, false);     // batch count
  v.setUint32(FIXED + 4, ecItemLen, false); // item length
  return buf.buffer;
}

describe('parsePartitionPack — essence container batch', () => {
  it('parses a well-formed batch', () => {
    const pp = parsePartitionPack(buildPP(2, 16, 2), 0);
    expect(pp.kind).toBe('header');
    expect(pp.essenceContainers).toHaveLength(2);
  });

  it('does not hang or over-read when the count is corrupt (no backing bytes)', () => {
    // Count claims ~4 billion items but the value holds none — the read must stay bounded.
    const pp = parsePartitionPack(buildPP(0xffffffff, 16, 0), 0);
    expect(pp.essenceContainers).toHaveLength(0);
  });

  it('ignores a zero item length rather than looping', () => {
    const pp = parsePartitionPack(buildPP(1000, 0, 0), 0);
    expect(pp.essenceContainers).toHaveLength(0);
  });
});

// ST 377-1 partition pack key: 06 0E 2B 34 02 05 01 01 0D 01 02 01 01 TT SS 00
//   TT (byte 13) = type:   02 header, 03 body, 04 footer
//   SS (byte 14) = status: 01 open/incomplete, 02 closed/incomplete, 03 open/complete, 04 closed/complete
function ppKey(type: number, status: number): Uint8Array {
  return new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,type,status,0x00]);
}
function buildPPWithKey(key: Uint8Array, valueLen = 88): ArrayBuffer {
  const ber = encodeBerLength(valueLen);
  const buf = new Uint8Array(16 + ber.length + valueLen);
  buf.set(key, 0);
  buf.set(ber, 16);
  return buf.buffer;
}

describe('parsePartitionPack — key layout (type byte 13, status byte 14)', () => {
  it.each([
    ['header closed/complete', 0x02, 0x04, 'header', 0, true],
    ['header open/incomplete', 0x02, 0x01, 'header', 1, false],
    ['body closed/complete',   0x03, 0x04, 'body',   0, true],
    ['body open/complete',     0x03, 0x03, 'body',   1, true],
    ['body closed/incomplete', 0x03, 0x02, 'body',   0, false],
    ['footer closed/complete', 0x04, 0x04, 'footer', 0, true],
    ['footer closed/incomplete', 0x04, 0x02, 'footer', 0, false],
  ] as const)('%s', (_name, type, status, kind, open, complete) => {
    const pp = parsePartitionPack(buildPPWithKey(ppKey(type, status)), 0);
    expect(pp.kind).toBe(kind);
    expect(pp.status).toBe(open);
    expect(pp.complete).toBe(complete);
  });

  it('rejects a Random Index Pack (byte 13 = 0x11) instead of parsing it as a partition', () => {
    // 7 RIP entries = 88-byte value: exactly enough for every fixed partition field.
    expect(() => parsePartitionPack(buildPPWithKey(ppKey(0x11, 0x01)), 0)).toThrow(/Partition Pack/);
  });
});
