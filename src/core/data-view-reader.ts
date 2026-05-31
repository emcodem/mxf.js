export class DataViewReader {
  private readonly view: DataView;
  private pos: number;

  constructor(buffer: ArrayBuffer, byteOffset = 0) {
    this.view = new DataView(buffer);
    this.pos = byteOffset;
  }

  get offset(): number { return this.pos; }
  get byteLength(): number { return this.view.byteLength; }
  get remaining(): number { return this.view.byteLength - this.pos; }

  seek(offset: number): void { this.pos = offset; }
  skip(n: number): void { this.pos += n; }

  readU8(): number { return this.view.getUint8(this.pos++); }

  readU16BE(): number {
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  readU32BE(): number {
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  readI32BE(): number {
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  readU64BE(): bigint {
    const hi = this.view.getUint32(this.pos, false);
    const lo = this.view.getUint32(this.pos + 4, false);
    this.pos += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  readI64BE(): bigint {
    const hi = this.view.getInt32(this.pos, false);
    const lo = this.view.getUint32(this.pos + 4, false);
    this.pos += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  readBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return bytes;
  }

  readBytesCopy(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    bytes.set(new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n));
    this.pos += n;
    return bytes;
  }

  peekU8(offset = 0): number { return this.view.getUint8(this.pos + offset); }

  slice(start: number, length: number): ArrayBuffer {
    return this.view.buffer.slice(this.view.byteOffset + start, this.view.byteOffset + start + length) as ArrayBuffer;
  }

  sliceFrom(start: number): ArrayBuffer {
    return this.slice(start, this.view.byteLength - start);
  }
}
