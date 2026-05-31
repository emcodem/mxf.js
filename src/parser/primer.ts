import { DataViewReader } from '../core/data-view-reader.js';
import { KLVPacket } from '../core/klv.js';

// Maps 2-byte local tag to 16-byte UL
export type PrimerPack = Map<number, Uint8Array>;

export function parsePrimerPack(buffer: ArrayBuffer, klv: KLVPacket): PrimerPack {
  const r = new DataViewReader(buffer, klv.valueOffset);
  // Batch array: 4-byte count, 4-byte item length (always 18 = 2 tag bytes + 16 UL bytes)
  const count = r.readU32BE();
  const itemLen = r.readU32BE();
  if (itemLen !== 18) {
    throw new Error(`Unexpected Primer Pack item length: ${itemLen}`);
  }

  const map: PrimerPack = new Map();
  for (let i = 0; i < count; i++) {
    const tag = r.readU16BE();
    const ul = r.readBytesCopy(16);
    map.set(tag, ul);
  }
  return map;
}
