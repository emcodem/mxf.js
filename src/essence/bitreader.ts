/**
 * Minimal MSB-first bit reader for H.264 RBSP, with Exp-Golomb decoding.
 *
 * Extracted from the inline reader that lived in `parseSPSCodedDimensions` (avc-tools.ts) so the
 * SPS parser, slice-header parser, and POC computer can all share one tested implementation.
 * Operates on an already-de-emulated RBSP (`stripEmulationPrevention` removes 00 00 03 → 00 00),
 * which keeps the bit positions identical to the spec's RBSP bit numbering.
 */
export class BitReader {
  private readonly bytes: Uint8Array;
  private bitPos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** Bits consumed so far (for byte-alignment checks / diagnostics). */
  get bitPosition(): number {
    return this.bitPos;
  }

  /** True once every bit of the backing buffer has been consumed. */
  get atEnd(): boolean {
    return this.bitPos >= this.bytes.length * 8;
  }

  /** Read a single bit (u(1)). Reads past the end yield 0 (RBSP is implicitly zero-extended). */
  u1(): number {
    const byteIdx = this.bitPos >> 3;
    if (byteIdx >= this.bytes.length) {
      this.bitPos++;
      return 0;
    }
    const bit = (this.bytes[byteIdx] >> (7 - (this.bitPos & 7))) & 1;
    this.bitPos++;
    return bit;
  }

  /** Read `n` bits as an unsigned big-endian integer (u(n)). */
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.u1();
    return v >>> 0;
  }

  /** Unsigned Exp-Golomb (ue(v)). */
  ue(): number {
    let zeros = 0;
    while (this.u1() === 0 && zeros < 32) zeros++;
    let v = 0;
    for (let i = 0; i < zeros; i++) v = (v << 1) | this.u1();
    return v + (1 << zeros) - 1;
  }

  /** Signed Exp-Golomb (se(v)). */
  se(): number {
    const k = this.ue();
    return (k & 1) ? (k + 1) >> 1 : -(k >> 1) || 0; // `|| 0` normalizes the k=0 case (avoids -0)
  }
}

/**
 * Remove H.264 emulation-prevention bytes from a NAL payload: any 0x03 that follows two 0x00 bytes
 * (the `00 00 03` → `00 00` rule) is dropped, yielding the raw byte sequence payload (RBSP).
 *
 * `skipHeaderByte` drops the leading NAL header byte first (the common case when handed a whole
 * NAL unit); pass false if `nal` already starts at the RBSP.
 */
export function stripEmulationPrevention(nal: Uint8Array, skipHeaderByte = true): Uint8Array {
  const start = skipHeaderByte ? 1 : 0;
  const out: number[] = [];
  let zeros = 0;
  for (let i = start; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue; // emulation-prevention byte
    }
    out.push(b);
    zeros = b === 0x00 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}
