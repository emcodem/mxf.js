import { decodeBerLength } from './ber.js';

export interface KLVPacket {
  key: Uint8Array;          // 16-byte UL key (view into buffer — do not retain)
  valueOffset: number;      // byte offset of value within the buffer
  valueLength: number;      // byte length of value
  totalLength: number;      // key (16) + length bytes + value bytes
}

const KEY_LENGTH = 16;

export function readKLV(buffer: ArrayBuffer, offset: number): KLVPacket {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  if (offset + KEY_LENGTH > buffer.byteLength) {
    throw new Error(`KLV: not enough data for key at offset ${offset}`);
  }

  const key = u8.subarray(offset, offset + KEY_LENGTH);
  const berOffset = offset + KEY_LENGTH;

  if (berOffset >= buffer.byteLength) {
    throw new Error(`KLV: no BER length at offset ${berOffset}`);
  }

  const { length: valueLength, bytesRead } = decodeBerLength(view, berOffset);
  const valueOffset = berOffset + bytesRead;

  if (valueOffset + valueLength > buffer.byteLength) {
    throw new Error(
      `KLV: value extends beyond buffer (offset=${valueOffset}, length=${valueLength}, bufLen=${buffer.byteLength})`
    );
  }

  return {
    key,
    valueOffset,
    valueLength,
    totalLength: KEY_LENGTH + bytesRead + valueLength,
  };
}

export class KLVIterator {
  private readonly buffer: ArrayBuffer;
  private readonly u8: Uint8Array;
  private pos: number;

  constructor(buffer: ArrayBuffer, startOffset = 0) {
    this.buffer = buffer;
    this.u8 = new Uint8Array(buffer);
    this.pos = startOffset;
  }

  get offset(): number { return this.pos; }

  hasMore(): boolean { return this.pos + KEY_LENGTH < this.buffer.byteLength; }

  next(): KLVPacket | null {
    if (!this.hasMore()) return null;
    try {
      const pkt = readKLV(this.buffer, this.pos);
      this.pos += pkt.totalLength;
      return pkt;
    } catch {
      // KLV value extends beyond buffer — advance past the key+BER so
      // callers can detect we hit a boundary and stop iterating.
      return null;
    }
  }

  // Peek at key without advancing
  peekKey(): Uint8Array | null {
    if (!this.hasMore()) return null;
    return this.u8.subarray(this.pos, this.pos + KEY_LENGTH);
  }

  getValue(pkt: KLVPacket): Uint8Array {
    return this.u8.subarray(pkt.valueOffset, pkt.valueOffset + pkt.valueLength);
  }

  getValueBuffer(pkt: KLVPacket): ArrayBuffer {
    return this.buffer.slice(pkt.valueOffset, pkt.valueOffset + pkt.valueLength);
  }

  // Skip the current KLV without parsing value
  skip(): void {
    if (!this.hasMore()) return;
    const pkt = readKLV(this.buffer, this.pos);
    this.pos += pkt.totalLength;
  }

  seekTo(offset: number): void { this.pos = offset; }

  // Skip over any leading sync/fill bytes (Run-In), returning offset of first valid KLV
  static skipRunIn(buffer: ArrayBuffer): number {
    const u8 = new Uint8Array(buffer);
    let i = 0;
    // MXF run-in is at most 65536 bytes of 0x00 / 0x00 0x00 0x00 0x01 sequence
    while (i < Math.min(65536, buffer.byteLength - KEY_LENGTH)) {
      // Check if this looks like a valid KLV key (starts with 06 0E 2B 34)
      if (u8[i] === 0x06 && u8[i+1] === 0x0e && u8[i+2] === 0x2b && u8[i+3] === 0x34) {
        return i;
      }
      i++;
    }
    return 0;
  }
}
