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
