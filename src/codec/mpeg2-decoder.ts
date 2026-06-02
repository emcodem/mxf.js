// Ported from C:\dev\jsmpeg2_git\jsmpeg (buffer.js + mpeg2.js).
// Stripped to decode-only: no canvas, no TS demuxer, no player infrastructure.

// The VLC/DC tree builders below self-test at module load. Set globalThis.MXFJS_DEBUG_VLC = true
// to print the per-table self-test summaries (off by default so importing the library is silent).
// A self-test *failure* still logs unconditionally — it means a table is corrupt, which is a real
// defect, not noise.
const DEBUG_VLC = (globalThis as { MXFJS_DEBUG_VLC?: boolean }).MXFJS_DEBUG_VLC === true;

export interface YUVFrame {
  y: Uint8ClampedArray;
  cb: Uint8ClampedArray;  // U plane
  cr: Uint8ClampedArray;  // V plane
  codedWidth: number;
  codedHeight: number;
  width: number;
  height: number;
  chromaFormat: number;   // 1 = 4:2:0, 2 = 4:2:2
  isKeyframe: boolean;
}

// ---------------------------------------------------------------------------
// BitBuffer (buffer.js)
// ---------------------------------------------------------------------------

class BitBuffer {
  bytes: Uint8Array;
  byteLength: number;
  index: number;

  constructor(size = 1024 * 1024) {
    this.bytes = new Uint8Array(size);
    this.byteLength = 0;
    this.index = 0;
  }

  resize(size: number): void {
    const n = new Uint8Array(size);
    if (this.byteLength) {
      this.byteLength = Math.min(this.byteLength, size);
      n.set(this.bytes.subarray(0, this.byteLength));
    }
    this.bytes = n;
    this.index = Math.min(this.index, this.byteLength << 3);
  }

  write(buffer: Uint8Array): void {
    // Drop fully-consumed bytes before appending. Without this the buffer only ever grows:
    // feeding a decoder a long continuous stream (e.g. transcoding a whole programme through
    // one persistent decoder) would balloon memory and, past ~256 MB, overflow the 32-bit
    // shifts used for the bit index (`byteLength << 3`, `i << 3`). Compacting on each write
    // keeps the working set to roughly the unparsed tail. `index & 7` preserves the sub-byte
    // read position within the first retained byte.
    const consumedBytes = this.index >> 3;
    if (consumedBytes > 0) {
      this.bytes.copyWithin(0, consumedBytes, this.byteLength);
      this.byteLength -= consumedBytes;
      this.index &= 7;
    }
    const avail = this.bytes.length - this.byteLength;
    if (buffer.length > avail) {
      this.resize(Math.max(this.bytes.length * 2, this.byteLength + buffer.length));
    }
    this.bytes.set(buffer, this.byteLength);
    this.byteLength += buffer.length;
  }

  reset(): void {
    this.byteLength = 0;
    this.index = 0;
  }

  findNextStartCode(): number {
    for (let i = (this.index + 7) >> 3; i < this.byteLength; i++) {
      if (this.bytes[i] === 0x00 && this.bytes[i + 1] === 0x00 && this.bytes[i + 2] === 0x01) {
        this.index = (i + 4) << 3;
        return this.bytes[i + 3];
      }
    }
    this.index = this.byteLength << 3;
    return -1;
  }

  findStartCode(code: number): number {
    let cur = 0;
    while (true) {
      cur = this.findNextStartCode();
      if (cur === code || cur === -1) return cur;
    }
  }

  nextBytesAreStartCode(): boolean {
    const i = (this.index + 7) >> 3;
    return i >= this.byteLength ||
      (this.bytes[i] === 0x00 && this.bytes[i + 1] === 0x00 && this.bytes[i + 2] === 0x01);
  }

  read(count: number): number {
    let offset = this.index;
    let value = 0;
    let c = count;
    while (c) {
      const b = this.bytes[offset >> 3];
      const rem = 8 - (offset & 7);
      const r = rem < c ? rem : c;
      const shift = rem - r;
      const mask = 0xff >> (8 - r);
      value = (value << r) | ((b & (mask << shift)) >> shift);
      offset += r;
      c -= r;
    }
    this.index += count;
    return value;
  }

  skip(count: number): void { this.index += count; }
  rewind(count: number): void { this.index = Math.max(this.index - count, 0); }
}

// ---------------------------------------------------------------------------
// MPEG-2 decoder (mpeg2.js)
// ---------------------------------------------------------------------------

const PICTURE_RATE = [
  0, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 0, 0, 0, 0, 0, 0, 0,
];

const ZIG_ZAG = new Uint8Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

const ALTERNATE_SCAN = new Uint8Array([
   0,  8, 16, 24,  1,  9,  2, 10,
  17, 25, 32, 40, 48, 56, 57, 49,
  41, 33, 26, 18,  3, 11,  4, 12,
  19, 27, 34, 42, 50, 58, 35, 43,
  51, 59, 20, 28,  5, 13,  6, 14,
  21, 29, 36, 44, 52, 60, 37, 45,
  53, 61, 22, 30,  7, 15, 23, 31,
  38, 46, 54, 62, 39, 47, 55, 63,
]);

const NON_LINEAR_QUANTIZER_SCALE = new Uint8Array([
    0,  1,  2,  3,  4,  5,  6,  7,
    8, 10, 12, 14, 16, 18, 20, 22,
   24, 28, 32, 36, 40, 44, 48, 52,
   56, 64, 72, 80, 88, 96,104,112,
]);

const DEFAULT_INTRA_QUANT_MATRIX = new Uint8Array([
   8, 16, 19, 22, 26, 27, 29, 34,
  16, 16, 22, 24, 27, 29, 34, 37,
  19, 22, 26, 27, 29, 34, 34, 38,
  22, 22, 26, 27, 29, 34, 37, 40,
  22, 26, 27, 29, 32, 35, 40, 48,
  26, 27, 29, 32, 35, 40, 48, 58,
  26, 27, 29, 34, 38, 46, 56, 69,
  27, 29, 35, 38, 46, 56, 69, 83,
]);

const DEFAULT_NON_INTRA_QUANT_MATRIX = new Uint8Array([
  16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16,
]);

const PREMULTIPLIER_MATRIX = new Uint8Array([
  32, 44, 42, 38, 32, 25, 17,  9,
  44, 62, 58, 52, 44, 35, 24, 12,
  42, 58, 55, 49, 42, 33, 23, 12,
  38, 52, 49, 44, 38, 30, 20, 10,
  32, 44, 42, 38, 32, 25, 17,  9,
  25, 35, 33, 30, 25, 20, 14,  7,
  17, 24, 23, 20, 17, 14,  9,  5,
   9, 12, 12, 10,  9,  7,  5,  2,
]);

// macroblock_address_increment VLC (ISO 13818-2 Table B-1 / ff_mpeg12_mbAddrIncrTable):
// [code, bits]. Indices 0..32 map to increments 1..33 (value = index+1). The two trailing
// special codes are added explicitly when the tree is built (after _buildLeafTree):
//   escape  '00000001000' (0x8,11) → value 35 (the decoder adds 33 and re-reads)
//   stuffing '00000001111' (0xf,11) → value 34 (the decoder skips and re-reads)
// FFmpeg's index-35 "end" marker {0x0,8} is the slice/sequence end detected via start
// codes, NOT a real increment code, so it is deliberately EXCLUDED from the VLC tree.
// Previously a hand-authored jsmpeg tree; the I-frame only ever uses increment 1, so the
// longer codes (and escape) were unverified. Rebuilt from canonical FFmpeg data with a
// Kraft + round-trip self-test. Source: libavcodec/mpeg12data.c (LGPL).
const _MBINCR_TAB: ReadonlyArray<readonly [number, number]> = [
  [0x1, 1], [0x3, 3], [0x2, 3], [0x3, 4], [0x2, 4], [0x3, 5], [0x2, 5], [0x7, 7],
  [0x6, 7], [0xb, 8], [0xa, 8], [0x9, 8], [0x8, 8], [0x7, 8], [0x6, 8], [0x17, 10],
  [0x16, 10], [0x15, 10], [0x14, 10], [0x13, 10], [0x12, 10], [0x23, 11], [0x22, 11], [0x21, 11],
  [0x20, 11], [0x1f, 11], [0x1e, 11], [0x1d, 11], [0x1c, 11], [0x1b, 11], [0x1a, 11], [0x19, 11],
  [0x18, 11],
];

// macroblock_type VLCs for I/P/B pictures (ISO 13818-2 Tables B-2/B-3/B-4). FFmpeg stores
// these as {code, len} with the resulting MB_TYPE flag value in a code comment; the value
// encoding (0x01 intra, 0x02 pattern, 0x04 backward, 0x08 forward, 0x10 quant) matches the
// decoder's bit tests exactly. P/B were hand-authored jsmpeg trees the all-intra I-frame
// never exercised; rebuilt from FFmpeg with Kraft + round-trip self-tests.
// Source: libavcodec/mpeg12.c table_mb_ptype / table_mb_btype (LGPL).
type LeafEntry = { code: number; bits: number; value: number };
const _MB_ITYPE_TAB: ReadonlyArray<LeafEntry> = [
  { code: 0x1, bits: 1, value: 0x01 }, // intra
  { code: 0x1, bits: 2, value: 0x11 }, // quant|intra
];
const _MB_PTYPE_TAB: ReadonlyArray<LeafEntry> = [
  { code: 0x3, bits: 5, value: 0x01 }, // intra
  { code: 0x1, bits: 2, value: 0x02 }, // pattern
  { code: 0x1, bits: 3, value: 0x08 }, // forward
  { code: 0x1, bits: 1, value: 0x0a }, // forward|pattern
  { code: 0x1, bits: 6, value: 0x11 }, // quant|intra
  { code: 0x1, bits: 5, value: 0x12 }, // quant|pattern
  { code: 0x2, bits: 5, value: 0x1a }, // quant|forward|pattern
];
const _MB_BTYPE_TAB: ReadonlyArray<LeafEntry> = [
  { code: 0x3, bits: 5, value: 0x01 }, // intra
  { code: 0x2, bits: 3, value: 0x04 }, // backward
  { code: 0x3, bits: 3, value: 0x06 }, // backward|pattern
  { code: 0x2, bits: 4, value: 0x08 }, // forward
  { code: 0x3, bits: 4, value: 0x0a }, // forward|pattern
  { code: 0x2, bits: 2, value: 0x0c }, // forward|backward
  { code: 0x3, bits: 2, value: 0x0e }, // forward|backward|pattern
  { code: 0x1, bits: 6, value: 0x11 }, // quant|intra
  { code: 0x2, bits: 6, value: 0x16 }, // quant|backward|pattern
  { code: 0x3, bits: 6, value: 0x1a }, // quant|forward|pattern
  { code: 0x2, bits: 5, value: 0x1e }, // quant|forward|backward|pattern
];

// coded_block_pattern VLC (ISO 13818-2 Table B-9 / ff_mpeg12_mbPatTable): [code, bits]
// indexed by the cbp value 0..63. Built into a readHuffman tree below (after _buildLeafTree)
// with a round-trip + Kraft self-test. This VLC has NO coverage from an all-intra picture
// (intra MBs force cbp rather than decoding it), so it was previously unverified.
const _CBP_TAB: ReadonlyArray<readonly [number, number]> = [
  [0x1, 9], [0xb, 5], [0x9, 5], [0xd, 6], [0xd, 4], [0x17, 7], [0x13, 7], [0x1f, 8],
  [0xc, 4], [0x16, 7], [0x12, 7], [0x1e, 8], [0x13, 5], [0x1b, 8], [0x17, 8], [0x13, 8],
  [0xb, 4], [0x15, 7], [0x11, 7], [0x1d, 8], [0x11, 5], [0x19, 8], [0x15, 8], [0x11, 8],
  [0xf, 6], [0xf, 8], [0xd, 8], [0x3, 9], [0xf, 5], [0xb, 8], [0x7, 8], [0x7, 9],
  [0xa, 4], [0x14, 7], [0x10, 7], [0x1c, 8], [0xe, 6], [0xe, 8], [0xc, 8], [0x2, 9],
  [0x10, 5], [0x18, 8], [0x14, 8], [0x10, 8], [0xe, 5], [0xa, 8], [0x6, 8], [0x6, 9],
  [0x12, 5], [0x1a, 8], [0x16, 8], [0x12, 8], [0xd, 5], [0x9, 8], [0x5, 8], [0x5, 9],
  [0xc, 5], [0x8, 8], [0x4, 8], [0x4, 9], [0x7, 3], [0xa, 5], [0x8, 5], [0xc, 6],
];

// motion_code magnitude VLC (ISO 13818-2 Table B-10 / ff_mpeg12_mbMotionVectorTable):
// [code, bits] for magnitudes 0..16. The full signed motion_code is the magnitude code
// followed by a sign bit, i.e. ±k = (magCode << 1) | sign (k > 0); magnitude 0 is just '1'.
// Built into a signed readHuffman tree below.
const _MV_MAG: ReadonlyArray<readonly [number, number]> = [
  [0x1, 1], [0x1, 2], [0x1, 3], [0x1, 4], [0x3, 6], [0x5, 7], [0x4, 7], [0x3, 7], [0xb, 9],
  [0xa, 9], [0x9, 9], [0x11, 10], [0x10, 10], [0xf, 10], [0xe, 10], [0xd, 10], [0xc, 10],
];

// MPEG-2 dct_dc_size VLC tables (ISO 13818-2 Tables B.12/B.13), built from the
// FFmpeg code/bits arrays. These cover sizes 0..11. The previous hand-authored
// tables only went to size 8 (the MPEG-1 range), so any DC differential of size
// 9..11 — which occurs with intra_dc_precision > 0 — hit a dead-end and desynced
// the bitstream. Leaf value = dct_dc_size.
// Source: libavcodec/mpeg12data.c ff_mpeg12_vlc_dc_{lum,chroma}_{code,bits} (LGPL).
const _DC_LUM_CODE = [0x4, 0x0, 0x1, 0x5, 0x6, 0xe, 0x1e, 0x3e, 0x7e, 0xfe, 0x1fe, 0x1ff];
const _DC_LUM_BITS = [3, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 9];
const _DC_CHR_CODE = [0x0, 0x1, 0x2, 0x6, 0xe, 0x1e, 0x3e, 0x7e, 0xfe, 0x1fe, 0x3fe, 0x3ff];
const _DC_CHR_BITS = [2, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10];

/** Build a ternary-tree VLC table whose leaf value is the entry index (for dct_dc_size). */
function _buildSimpleTree(codes: number[], bits: number[], label: string): Int32Array {
  const nodes: number[][] = [[-1, -1, 0]];
  function childOf(n: number, bit: number): number {
    if (nodes[n][bit] < 0) { nodes[n][bit] = nodes.length * 3; nodes.push([-1, -1, 0]); }
    return nodes[n][bit] / 3;
  }
  for (let i = 0; i < codes.length; i++) {
    const b = codes[i].toString(2).padStart(bits[i], '0');
    let n = 0;
    for (let k = 0; k < b.length - 1; k++) n = childOf(n, +b[k]);
    const t = nodes.length * 3; nodes.push([0, 0, i]); nodes[n][+b[b.length - 1]] = t;
  }
  const flat = new Int32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) { flat[i*3] = nodes[i][0]; flat[i*3+1] = nodes[i][1]; flat[i*3+2] = nodes[i][2]; }
  // Self-test: replay each code, confirm value and exact bit count.
  let fails = 0;
  for (let i = 0; i < codes.length; i++) {
    const b = codes[i].toString(2).padStart(bits[i], '0');
    let state = 0, c = 0;
    do { state = flat[state + (+b[c])]; c++; } while (state >= 0 && flat[state] !== 0 && c < b.length + 4);
    if (flat[state + 2] !== i || c !== bits[i]) { fails++; console.error(`[DC ${label}] entry ${i} code=${b} got=${flat[state+2]} bits=${c}/${bits[i]}`); }
  }
  if (DEBUG_VLC) console.log(`[DC ${label}] self-test: ${codes.length - fails}/${codes.length} OK`);
  return flat;
}

const DCT_DC_SIZE_LUMINANCE   = _buildSimpleTree(_DC_LUM_CODE, _DC_LUM_BITS, 'lum');
const DCT_DC_SIZE_CHROMINANCE = _buildSimpleTree(_DC_CHR_CODE, _DC_CHR_BITS, 'chroma');

// ---------------------------------------------------------------------------
// Table B-14 (ff_mpeg1_vlc_table): standard DCT coefficient VLC, used for ALL
// non-intra (inter) blocks and for intra blocks when intra_vlc_format == 0.
// This is the "dct_coeff_next" table: (run0,level1)='11', EOB='10', escape='000001'.
// The previous hand-authored tree had a transcription error (kraft 0.999756 — one
// codeword routed to a dead end), which the all-intra I-frame never hit but every
// inter block did. Rebuilt from the canonical FFmpeg data with the Kraft-checked
// _buildVlcTree so completeness is verified at load. Run/level are shared with B-15
// (ff_mpeg12_run / ff_mpeg12_level == _MPEG12_RUN / _MPEG12_LEVEL).
// Source: libavcodec/mpeg12data.c (LGPL).
// ---------------------------------------------------------------------------
const _B14_VLCS: ReadonlyArray<readonly [number, number]> = [
  [0x3, 2], [0x4, 4], [0x5, 5], [0x6, 7], [0x26, 8], [0x21, 8], [0xa, 10], [0x1d, 12],
  [0x18, 12], [0x13, 12], [0x10, 12], [0x1a, 13], [0x19, 13], [0x18, 13], [0x17, 13], [0x1f, 14],
  [0x1e, 14], [0x1d, 14], [0x1c, 14], [0x1b, 14], [0x1a, 14], [0x19, 14], [0x18, 14], [0x17, 14],
  [0x16, 14], [0x15, 14], [0x14, 14], [0x13, 14], [0x12, 14], [0x11, 14], [0x10, 14], [0x18, 15],
  [0x17, 15], [0x16, 15], [0x15, 15], [0x14, 15], [0x13, 15], [0x12, 15], [0x11, 15], [0x10, 15],
  [0x3, 3], [0x6, 6], [0x25, 8], [0xc, 10], [0x1b, 12], [0x16, 13], [0x15, 13], [0x1f, 15],
  [0x1e, 15], [0x1d, 15], [0x1c, 15], [0x1b, 15], [0x1a, 15], [0x19, 15], [0x13, 16], [0x12, 16],
  [0x11, 16], [0x10, 16], [0x5, 4], [0x4, 7], [0xb, 10], [0x14, 12], [0x14, 13], [0x7, 5],
  [0x24, 8], [0x1c, 12], [0x13, 13], [0x6, 5], [0xf, 10], [0x12, 12], [0x7, 6], [0x9, 10],
  [0x12, 13], [0x5, 6], [0x1e, 12], [0x14, 16], [0x4, 6], [0x15, 12], [0x7, 7], [0x11, 12],
  [0x5, 7], [0x11, 13], [0x27, 8], [0x10, 13], [0x23, 8], [0x1a, 16], [0x22, 8], [0x19, 16],
  [0x20, 8], [0x18, 16], [0xe, 10], [0x17, 16], [0xd, 10], [0x16, 16], [0x8, 10], [0x15, 16],
  [0x1f, 12], [0x1a, 12], [0x19, 12], [0x17, 12], [0x16, 12], [0x1f, 13], [0x1e, 13], [0x1d, 13],
  [0x1c, 13], [0x1b, 13], [0x1f, 16], [0x1e, 16], [0x1d, 16], [0x1c, 16], [0x1b, 16],
  [0x1, 6],  // escape → 0xffff
  [0x2, 2],  // EOB    → 0xFFFE ('10')
];

// ---------------------------------------------------------------------------
// Table B-15 (ff_mpeg2_vlc_table): alternate DCT coefficient VLC for intra
// blocks, used when intra_vlc_format == 1.
// Source: ISO 13818-2, Annex B, Table B.15 / FFmpeg libavcodec/mpeg12data.c (LGPL)
// ff_mpeg2_vlc_table entries: [code_msb_first, bit_length]
// 0..110 correspond to ff_mpeg12_run/ff_mpeg12_level; 111=escape; 112=EOB
// ---------------------------------------------------------------------------

const _B15_VLCS: ReadonlyArray<readonly [number, number]> = [
  [0x02, 2], [0x06, 3], [0x07, 4], [0x1c, 5], [0x1d, 5], [0x05, 6], [0x04, 6], [0x7b, 7],
  [0x7c, 7], [0x23, 8], [0x22, 8], [0xfa, 8], [0xfb, 8], [0xfe, 8], [0xff, 8], [0x1f,14],
  [0x1e,14], [0x1d,14], [0x1c,14], [0x1b,14], [0x1a,14], [0x19,14], [0x18,14], [0x17,14],
  [0x16,14], [0x15,14], [0x14,14], [0x13,14], [0x12,14], [0x11,14], [0x10,14], [0x18,15],
  [0x17,15], [0x16,15], [0x15,15], [0x14,15], [0x13,15], [0x12,15], [0x11,15], [0x10,15],
  [0x02, 3], [0x06, 5], [0x79, 7], [0x27, 8], [0x20, 8], [0x16,13], [0x15,13], [0x1f,15],
  [0x1e,15], [0x1d,15], [0x1c,15], [0x1b,15], [0x1a,15], [0x19,15], [0x13,16], [0x12,16],
  [0x11,16], [0x10,16], [0x05, 5], [0x07, 7], [0xfc, 8], [0x0c,10], [0x14,13], [0x07, 5],
  [0x26, 8], [0x1c,12], [0x13,13], [0x06, 6], [0xfd, 8], [0x12,12], [0x07, 6], [0x04, 9],
  [0x12,13], [0x06, 7], [0x1e,12], [0x14,16], [0x04, 7], [0x15,12], [0x05, 7], [0x11,12],
  [0x78, 7], [0x11,13], [0x7a, 7], [0x10,13], [0x21, 8], [0x1a,16], [0x25, 8], [0x19,16],
  [0x24, 8], [0x18,16], [0x05, 9], [0x17,16], [0x07, 9], [0x16,16], [0x0d,10], [0x15,16],
  [0x1f,12], [0x1a,12], [0x19,12], [0x17,12], [0x16,12], [0x1f,13], [0x1e,13], [0x1d,13],
  [0x1c,13], [0x1b,13], [0x1f,16], [0x1e,16], [0x1d,16], [0x1c,16], [0x1b,16],
  [0x01, 6],  // escape → 0xffff
  [0x06, 4],  // EOB    → 0xFFFE (B-15 uses 4-bit EOB, not the 0x0001 trick used for B-14)
];
const _MPEG12_RUN = new Uint8Array([
   0, 0, 0, 0, 0, 0, 0, 0,  0, 0, 0, 0, 0, 0, 0, 0,
   0, 0, 0, 0, 0, 0, 0, 0,  0, 0, 0, 0, 0, 0, 0, 0,
   0, 0, 0, 0, 0, 0, 0, 0,
   1, 1, 1, 1, 1, 1, 1, 1,  1, 1, 1, 1, 1, 1, 1, 1,  1, 1,
   2, 2, 2, 2, 2,
   3, 3, 3, 3,
   4, 4, 4,  5, 5, 5,  6, 6, 6,  7, 7,  8, 8,  9, 9,
  10,10, 11,11, 12,12, 13,13, 14,14, 15,15, 16,16,
  17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
]);
const _MPEG12_LEVEL = new Uint8Array([
   1, 2, 3, 4, 5, 6, 7, 8,  9,10,11,12,13,14,15,16,
  17,18,19,20,21,22,23,24, 25,26,27,28,29,30,31,32,
  33,34,35,36,37,38,39,40,
   1, 2, 3, 4, 5, 6, 7, 8,  9,10,11,12,13,14,15,16,  17,18,
   1, 2, 3, 4, 5,
   1, 2, 3, 4,
   1, 2, 3,  1, 2, 3,  1, 2, 3,  1, 2,  1, 2,  1, 2,
   1, 2,  1, 2,  1, 2,  1, 2,  1, 2,  1, 2,  1, 2,
   1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]);

/**
 * Build a ternary-tree VLC lookup array in the same format as DCT_COEFF_B14, matching
 * the traversal in readHuffman():
 *   - terminal node = [0, 0, value]   (left slot 0 marks "leaf"; readHuffman stops here)
 *   - internal node = [leftChild|−1, rightChild|−1, 0]
 * A *missing* child of an internal node MUST be −1, not 0 — otherwise readHuffman would
 * mistake the internal node for a leaf and stop early (returning value 0), desyncing the
 * bitstream. Child indices are nodes.length*3 ≥ 3, so they never collide with the 0 marker.
 */
function _buildVlcTree(
  vlcs: ReadonlyArray<readonly [number, number]>,
  run: Uint8Array, level: Uint8Array,
): Int32Array {
  const nodes: number[][] = [[-1, -1, 0]]; // root: internal, no children yet
  function childOf(n: number, bit: number): number {
    if (nodes[n][bit] < 0) { nodes[n][bit] = nodes.length * 3; nodes.push([-1, -1, 0]); }
    return nodes[n][bit] / 3;
  }
  for (let i = 0; i < vlcs.length; i++) {
    const [code, len] = vlcs[i];
    let val: number;
    if (i === vlcs.length - 2) val = 0xffff;        // escape
    else if (i === vlcs.length - 1) val = 0xFFFE;   // EOB sentinel for B-14
    else val = (run[i] << 8) | level[i];
    const bits = code.toString(2).padStart(len, '0');
    let n = 0;
    for (let b = 0; b < bits.length - 1; b++) n = childOf(n, +bits[b]);
    const last = +bits[bits.length - 1];
    if (nodes[n][last] >= 0) {
      console.error(`[VLC] collision at entry ${i} (code=${code.toString(2)}, len=${len}) — overwriting slot`);
    }
    const t = nodes.length * 3; nodes.push([0, 0, val]); nodes[n][last] = t;
  }
  const flat = new Int32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) { flat[i*3] = nodes[i][0]; flat[i*3+1] = nodes[i][1]; flat[i*3+2] = nodes[i][2]; }

  // Self-test: replay every code through the exact readHuffman traversal and confirm
  // it returns the right value AND consumes exactly `len` bits (a wrong bit-count is
  // precisely what desyncs the stream). Logs to console; captured by the e2e debug test.
  let fails = 0;
  for (let i = 0; i < vlcs.length; i++) {
    const [code, len] = vlcs[i];
    const expected = i === vlcs.length - 2 ? 0xffff
                   : i === vlcs.length - 1 ? 0xFFFE
                   : (run[i] << 8) | level[i];
    const bits = code.toString(2).padStart(len, '0');
    let state = 0, consumed = 0;
    do {
      const bit = +bits[consumed]; consumed++;
      state = flat[state + bit];
    } while (state >= 0 && flat[state] !== 0 && consumed < bits.length + 4);
    const got = flat[state + 2];
    if (got !== expected || consumed !== len) {
      fails++;
      if (fails <= 8) console.error(`[VLC] entry ${i}: code=${bits} expected=0x${expected.toString(16)} got=0x${(got>>>0).toString(16)} bitsConsumed=${consumed}/${len}`);
    }
  }
  // Kraft inequality: for a COMPLETE prefix code, sum(2^-length) === 1 exactly.
  // This is independent of the self-test (which pads with our own lengths) and so
  // catches a wrong code LENGTH — the exact error that leaves a real bit pattern
  // routing to a dead -1 child during decode.
  let kraft = 0;
  for (let i = 0; i < vlcs.length; i++) kraft += Math.pow(2, -vlcs[i][1]);
  // Also count dead ends: internal nodes with a -1 child mark codewords with no leaf.
  let deadChildren = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i][2] === 0) { // internal node
      if (nodes[i][0] === -1) deadChildren++;
      if (nodes[i][1] === -1) deadChildren++;
    }
  }
  if (DEBUG_VLC) console.log(`[VLC] tree self-test: ${vlcs.length - fails}/${vlcs.length} codes OK, ${nodes.length} nodes, kraft=${kraft.toFixed(6)} (want 1.0), deadChildren=${deadChildren}`);
  return flat;
}

// B-15 (ff_mpeg2_vlc_table), used by intra blocks when intra_vlc_format==1.
// Distinct 4-bit EOB (code '0110' → leaf 0xFFFE).
const DCT_COEFF_B15 = _buildVlcTree(_B15_VLCS, _MPEG12_RUN, _MPEG12_LEVEL);
// B-14 (dct_coeff_next), used by inter blocks and intra blocks with intra_vlc_format==0.
// EOB is the leaf 0xFFFE (code '10'); (run0,level1) is the leaf 0x0001 (code '11').
const DCT_COEFF_B14 = _buildVlcTree(_B14_VLCS, _MPEG12_RUN, _MPEG12_LEVEL);

/**
 * Build a readHuffman-compatible ternary-tree from explicit (code, bits, value) entries.
 * Same node layout as _buildVlcTree (leaf = [0,0,value]; internal = [child|−1, child|−1, 0]),
 * but the leaf value is supplied directly (used for coded_block_pattern and motion_code,
 * whose leaves are not run/level pairs). Self-tests every code for value + exact bit length
 * and reports the Kraft sum.
 */
function _buildLeafTree(entries: ReadonlyArray<{ code: number; bits: number; value: number }>, label: string): Int32Array {
  const nodes: number[][] = [[-1, -1, 0]];
  const childOf = (n: number, bit: number): number => {
    if (nodes[n][bit] < 0) { nodes[n][bit] = nodes.length * 3; nodes.push([-1, -1, 0]); }
    return nodes[n][bit] / 3;
  };
  for (const { code, bits, value } of entries) {
    const b = code.toString(2).padStart(bits, '0');
    let n = 0;
    for (let k = 0; k < b.length - 1; k++) n = childOf(n, +b[k]);
    const t = nodes.length * 3; nodes.push([0, 0, value]); nodes[n][+b[b.length - 1]] = t;
  }
  const flat = new Int32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) { flat[i * 3] = nodes[i][0]; flat[i * 3 + 1] = nodes[i][1]; flat[i * 3 + 2] = nodes[i][2]; }
  let fails = 0, kraft = 0;
  for (const { code, bits, value } of entries) {
    const b = code.toString(2).padStart(bits, '0');
    let state = 0, c = 0;
    do { state = flat[state + (+b[c])]; c++; } while (state >= 0 && flat[state] !== 0 && c < b.length + 4);
    if (flat[state + 2] !== value || c !== bits) fails++;
    kraft += Math.pow(2, -bits);
  }
  if (DEBUG_VLC) console.log(`[${label}] tree self-test: ${entries.length - fails}/${entries.length} codes OK, kraft=${kraft.toFixed(6)} (want 1.0)`);
  return flat;
}

// coded_block_pattern: leaf value = cbp pattern (0..63).
const CODE_BLOCK_PATTERN = _buildLeafTree(
  _CBP_TAB.map(([code, bits], value) => ({ code, bits, value })), 'CBP');

// motion_code: signed leaf value. Magnitude 0 = code '1'; ±k (k>0) = (magCode<<1)|sign.
const MOTION = _buildLeafTree(
  [
    { code: 0x1, bits: 1, value: 0 },
    ..._MV_MAG.slice(1).flatMap(([code, bits], i) => {
      const mag = i + 1;
      return [
        { code: code << 1, bits: bits + 1, value: mag },
        { code: (code << 1) | 1, bits: bits + 1, value: -mag },
      ];
    }),
  ], 'MOTION');

// macroblock_address_increment: leaf value = increment (1..33); escape '00000001000' → 35
// (decoder adds 33, re-reads), stuffing '00000001111' → 34 (decoder skips, re-reads). The
// {0x0,8} "end" code is intentionally absent (it is the slice end, caught by start codes).
const MACROBLOCK_ADDRESS_INCREMENT = _buildLeafTree(
  [
    ..._MBINCR_TAB.map(([code, bits], i) => ({ code, bits, value: i + 1 })),
    { code: 0x8, bits: 11, value: 35 }, // macroblock_escape
    { code: 0xf, bits: 11, value: 34 }, // macroblock_stuffing
  ], 'MBINCR');

// macroblock_type per picture type. Leaf value = MB_TYPE flags (see _MB_*TYPE_TAB).
const MACROBLOCK_TYPE_INTRA       = _buildLeafTree(_MB_ITYPE_TAB.slice(), 'MBTYPE-I');
const MACROBLOCK_TYPE_PREDICTIVE  = _buildLeafTree(_MB_PTYPE_TAB.slice(), 'MBTYPE-P');
const MACROBLOCK_TYPE_B           = _buildLeafTree(_MB_BTYPE_TAB.slice(), 'MBTYPE-B');
const MACROBLOCK_TYPE: (Int32Array | null)[] = [
  null,
  MACROBLOCK_TYPE_INTRA,
  MACROBLOCK_TYPE_PREDICTIVE,
  MACROBLOCK_TYPE_B,
];

const PICTURE_TYPE = { INTRA: 1, PREDICTIVE: 2, B: 3 };
const START = { SEQUENCE: 0xB3, SLICE_FIRST: 0x01, SLICE_LAST: 0xAF, PICTURE: 0x00, EXTENSION: 0xB5, USER_DATA: 0xB2 };

// ---------------------------------------------------------------------------

export class Mpeg2Decoder {
  private bits: BitBuffer;
  private onFrame: (frame: YUVFrame) => void;

  // sequence state
  private hasSequenceHeader = false;
  private isMPEG2 = false;
  private width = 0;
  private height = 0;
  frameRate = 25;
  private chromaFormat = 1;
  // picture coding extension state
  private intraDcPrecision = 0;
  private intraVlcFormat = false;
  private qScaleType = false;
  private alternateScan = false;
  private pictureStructure = 3;       // 3 = frame picture
  private framePredFrameDct = true;   // when false, each MB carries a dct_type bit
  private dctType = false;            // current MB: true = field DCT, false = frame DCT
  private fCode: [[number, number], [number, number]] = [[1, 1], [1, 1]];

  // macroblock geometry
  private mbWidth = 0;
  private mbHeight = 0;
  private mbSize = 0;
  private codedWidth = 0;
  private codedHeight = 0;
  private codedSize = 0;
  private halfWidth = 0;

  // YUV plane buffers (reused across frames via rotation)
  private currentY = new Uint8ClampedArray(0);
  private currentY32 = new Uint32Array(0);
  private currentCr = new Uint8ClampedArray(0);
  private currentCr32 = new Uint32Array(0);
  private currentCb = new Uint8ClampedArray(0);
  private currentCb32 = new Uint32Array(0);
  private forwardY = new Uint8ClampedArray(0);
  private forwardY32 = new Uint32Array(0);
  private forwardCr = new Uint8ClampedArray(0);
  private forwardCr32 = new Uint32Array(0);
  private forwardCb = new Uint8ClampedArray(0);
  private forwardCb32 = new Uint32Array(0);
  private backwardY = new Uint8ClampedArray(0);
  private backwardY32 = new Uint32Array(0);
  private backwardCr = new Uint8ClampedArray(0);
  private backwardCr32 = new Uint32Array(0);
  private backwardCb = new Uint8ClampedArray(0);
  private backwardCb32 = new Uint32Array(0);

  // quant matrices
  private intraQuantMatrix = DEFAULT_INTRA_QUANT_MATRIX;
  private nonIntraQuantMatrix = DEFAULT_NON_INTRA_QUANT_MATRIX;
  // 4:2:2/4:4:4 may carry separate chroma matrices; default to the luma matrices.
  private chromaIntraQuantMatrix = DEFAULT_INTRA_QUANT_MATRIX;
  private chromaNonIntraQuantMatrix = DEFAULT_NON_INTRA_QUANT_MATRIX;
  private customIntraQuantMatrix = new Uint8Array(64);
  private customNonIntraQuantMatrix = new Uint8Array(64);
  private customChromaIntraQuantMatrix = new Uint8Array(64);
  private customChromaNonIntraQuantMatrix = new Uint8Array(64);

  // picture state
  private pictureType = 0;
  private hasHeldAnchor = false;
  // Type of the frame currently held back as the display-reorder anchor (the I/P in forwardY).
  // Tracked separately because at emit time `pictureType` is the NEXT picture being decoded, so it
  // can't tell us whether the HELD frame was the keyframe.
  private heldAnchorIsKeyframe = false;
  // Set by reset(): after a seek/scrub we discard emitted frames until the random-access I-frame is
  // emitted, so an undecodable open-GOP leading B never lands at the keyframe's slot. Cleared the
  // moment that keyframe is emitted.
  private suppressUntilKeyframe = false;
  private fullPelForward = false;

  // macroblock state
  private macroblockAddress = 0;
  private mbRow = 0;
  private mbCol = 0;
  private macroblockType = 0;
  private macroblockIntra = false;
  private macroblockMotFw = false;
  private macroblockMotBw = false;
  private motionFwH = 0;
  private motionFwV = 0;
  private motionFwHPrev = 0;
  private motionFwVPrev = 0;
  private motionBwH = 0;
  private motionBwV = 0;
  private motionBwHPrev = 0;
  private motionBwVPrev = 0;

  // MPEG-2 inter-prediction state (P/B frames). ISO 13818-2 7.6.
  // PMV[r][s][t]: r = motion-vector index (0/1; 1 only for field/16×8/dual-prime),
  //               s = direction (0 = forward, 1 = backward),
  //               t = component (0 = horizontal, 1 = vertical).
  private PMV: number[][][] = [[[0, 0], [0, 0]], [[0, 0], [0, 0]]];
  private fieldSelect: number[][] = [[0, 0], [0, 0]]; // motion_vertical_field_select[r][s]
  private mvCount = 1;            // 1 or 2 motion vectors per direction
  private mvFormatField = false;  // true = field mv_format, false = frame mv_format
  private mvScale = false;        // vertical PMV scaling (field mv in a frame picture)
  private dmv = false;            // dual-prime
  private concealmentMotionVectors = false; // intra MBs carry a forward MV + marker

  private quantizerScale = 0;
  private sliceBegin = false;
  private dcPredictorY = 0;
  private dcPredictorCr = 0;
  private dcPredictorCb = 0;
  private blockData = new Int32Array(64);

  constructor(onFrame: (frame: YUVFrame) => void, bufferSize = 4 * 1024 * 1024) {
    this.onFrame = onFrame;
    this.bits = new BitBuffer(bufferSize);
  }

  /** Feed raw MPEG-2 elementary stream bytes (one or more access units). */
  write(data: ArrayBuffer): void {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bits.write(u8);
    if (!this.hasSequenceHeader) {
      if (this.bits.findStartCode(START.SEQUENCE) === -1) return;
      this.decodeSequenceHeader();
    }
  }

  /** Decode one picture. Returns true if a picture was decoded and onFrame fired. */
  decode(): boolean {
    if (!this.hasSequenceHeader) return false;
    if (this.bits.findStartCode(START.PICTURE) === -1) return false;
    this.decodePicture();
    return true;
  }

  /**
   * After the last frame of a segment, the final I/P anchor is held back.
   * Call flush() to emit it.
   */
  flush(): void {
    if (this.hasHeldAnchor) {
      if (!this.suppressUntilKeyframe || this.heldAnchorIsKeyframe) {
        this.emitFrame(this.forwardY, this.forwardCb, this.forwardCr, this.heldAnchorIsKeyframe);
        if (this.heldAnchorIsKeyframe) this.suppressUntilKeyframe = false;
      }
      this.hasHeldAnchor = false;
    }
  }

  debugInfo(): Record<string, unknown> {
    return {
      hasSequenceHeader: this.hasSequenceHeader,
      isMPEG2: this.isMPEG2,
      width: this.width, height: this.height,
      chromaFormat: this.chromaFormat,
      pictureType: this.pictureType,
      intraDcPrecision: this.intraDcPrecision,
      intraVlcFormat: this.intraVlcFormat,
      qScaleType: this.qScaleType,
      alternateScan: this.alternateScan,
      intraQuantMatrix_0_7: Array.from(this.intraQuantMatrix.slice(0, 8)),
      mbWidth: this.mbWidth, mbHeight: this.mbHeight, mbSize: this.mbSize,
      concealmentMotionVectors: this.concealmentMotionVectors,
      framePredFrameDct: this.framePredFrameDct,
      pictureStructure: this.pictureStructure,
      chromaIntraQuantMatrix_0_7: Array.from(this.chromaIntraQuantMatrix.slice(0, 8)),
    };
  }

  /**
   * Reset for a new seek position: drop the buffered bitstream and the held anchor, but KEEP
   * the parsed sequence header (dimensions, frame rate, quant matrices, chroma format). Those
   * are constant for the whole clip, so retaining them lets the decoder restart at any keyframe
   * even when that keyframe's access unit does not re-transmit a sequence header — otherwise
   * decode() would bail (hasSequenceHeader=false) and the seeked frame would never appear.
   *
   * OPEN GOPs (XDCAM long-GOP): a GOP's leading B-frames are coded after the I but displayed before
   * it and reference the PREVIOUS GOP's anchor. After a seek/scrub into such a GOP that anchor is
   * gone, so those B-frames are undecodable. We therefore SUPPRESS emitted frames until the
   * random-access I-frame is emitted (`suppressUntilKeyframe`) — the keyframe, not an undecodable
   * leading B, lands at the keyframe's slot. As defence-in-depth the reference buffers are also
   * blanked to neutral grey (Y=0, chroma=128 — NOT all-zero, which is bright green in YUV).
   */
  reset(): void {
    this.bits.reset();
    this.hasHeldAnchor = false;
    this.pictureType = 0;
    this.suppressUntilKeyframe = true;
    this.currentY.fill(0);  this.currentCb.fill(128);  this.currentCr.fill(128);
    this.forwardY.fill(0);  this.forwardCb.fill(128);  this.forwardCr.fill(128);
    this.backwardY.fill(0); this.backwardCb.fill(128); this.backwardCr.fill(128);
  }

  // -------------------------------------------------------------------------
  // Internal: sequence header
  // -------------------------------------------------------------------------

  private decodeSequenceHeader(): void {
    const newWidth = this.bits.read(12);
    const newHeight = this.bits.read(12);
    this.bits.skip(4); // pixel aspect ratio
    this.frameRate = PICTURE_RATE[this.bits.read(4)] || 25;
    this.bits.skip(18 + 1 + 10 + 1); // bitRate, marker, bufferSize, constrained

    // Reset to defaults; the flags below override them when present in the bitstream.
    // Must happen here, before initBuffers() (which no longer resets matrices), so
    // a sequence header without custom matrices correctly reverts to defaults.
    this.intraQuantMatrix = DEFAULT_INTRA_QUANT_MATRIX;
    this.nonIntraQuantMatrix = DEFAULT_NON_INTRA_QUANT_MATRIX;

    if (this.bits.read(1)) { // custom intra quant matrix
      for (let i = 0; i < 64; i++) this.customIntraQuantMatrix[ZIG_ZAG[i]] = this.bits.read(8);
      this.intraQuantMatrix = this.customIntraQuantMatrix;
    }
    if (this.bits.read(1)) { // custom non-intra quant matrix
      for (let i = 0; i < 64; i++) this.customNonIntraQuantMatrix[ZIG_ZAG[i]] = this.bits.read(8);
      this.nonIntraQuantMatrix = this.customNonIntraQuantMatrix;
    }

    const nextCode = this.bits.findNextStartCode();
    if (nextCode === START.EXTENSION) {
      const extId = this.bits.read(4);
      if (extId === 0x01) this.decodeSequenceExtension();
    } else if (nextCode !== -1) {
      this.bits.rewind(32);
    }

    if (newWidth !== this.width || newHeight !== this.height) {
      this.width = newWidth;
      this.height = newHeight;
      this.initBuffers();
    }
    this.hasSequenceHeader = true;
  }

  private decodeSequenceExtension(): void {
    this.isMPEG2 = true;
    this.bits.skip(8); // profile_and_level_indication
    this.bits.skip(1); // progressive_sequence
    this.chromaFormat = this.bits.read(2);
    // Only 4:2:0 (1) and 4:2:2 (2) are supported. 4:4:4 (3) and the reserved value (0) would
    // silently mis-size the chroma planes (initBuffers) and block counts (decodeMacroblock),
    // producing corrupt output or a buffer overrun — so reject them loudly here at parse time.
    // (D-10 is 4:2:2; most Long-GOP MPEG-2 is 4:2:0.)
    if (this.chromaFormat !== 1 && this.chromaFormat !== 2) {
      const name = this.chromaFormat === 3 ? '4:4:4' : `reserved (${this.chromaFormat})`;
      throw new Error(`Unsupported MPEG-2 chroma_format ${name} — only 4:2:0 and 4:2:2 are supported`);
    }
    this.bits.skip(2 + 2 + 12 + 1 + 8 + 1 + 2 + 5);
  }

  private initBuffers(): void {
    this.mbWidth  = (this.width  + 15) >> 4;
    this.mbHeight = (this.height + 15) >> 4;
    this.mbSize   = this.mbWidth * this.mbHeight;
    this.codedWidth  = this.mbWidth  << 4;
    this.codedHeight = this.mbHeight << 4;
    this.codedSize   = this.codedWidth * this.codedHeight;
    this.halfWidth   = this.mbWidth  << 3;

    const chromaSize = this.chromaFormat === 2
      ? (this.codedSize >> 1) : (this.codedSize >> 2);

    const makeY  = () => { const a = new Uint8ClampedArray(this.codedSize);  return { a, a32: new Uint32Array(a.buffer) }; };
    const makeCh = () => { const a = new Uint8ClampedArray(chromaSize); return { a, a32: new Uint32Array(a.buffer) }; };

    let t = makeY();  this.currentY  = t.a; this.currentY32  = t.a32;
    t = makeCh(); this.currentCr = t.a; this.currentCr32 = t.a32;
    t = makeCh(); this.currentCb = t.a; this.currentCb32 = t.a32;

    t = makeY();  this.forwardY  = t.a; this.forwardY32  = t.a32;
    t = makeCh(); this.forwardCr = t.a; this.forwardCr32 = t.a32;
    t = makeCh(); this.forwardCb = t.a; this.forwardCb32 = t.a32;

    t = makeY();   this.backwardY  = t.a; this.backwardY32  = t.a32;
    t = makeCh(); this.backwardCr = t.a; this.backwardCr32 = t.a32;
    t = makeCh(); this.backwardCb = t.a; this.backwardCb32 = t.a32;
  }

  // -------------------------------------------------------------------------
  // Internal: picture layer
  // -------------------------------------------------------------------------

  private decodePicture(): void {
    this.bits.skip(10); // temporal_reference
    this.pictureType = this.bits.read(3);
    this.bits.skip(16); // vbv_delay

    if (this.pictureType <= 0 || this.pictureType > PICTURE_TYPE.B) return;

    if (!this.isMPEG2) {
      // MPEG-1
      if (this.pictureType === PICTURE_TYPE.PREDICTIVE) {
        this.fullPelForward = this.bits.read(1) === 1;
        const fcode = this.bits.read(3);
        if (fcode === 0) return;
        this.fCode[0][0] = this.fCode[0][1] = fcode;
      }
      if (this.pictureType === PICTURE_TYPE.B) return; // not supported in MPEG-1 mode

      let code: number;
      do { code = this.bits.findNextStartCode(); } while (code === START.EXTENSION || code === START.USER_DATA);
      while (code >= START.SLICE_FIRST && code <= START.SLICE_LAST) {
        this.decodeSlice(code & 0xff);
        code = this.bits.findNextStartCode();
      }
      if (code !== -1) this.bits.rewind(32);
    } else {
      // MPEG-2: parse EACH extension by its 4-bit identifier. The old code parsed
      // only the first (picture_coding_extension) and then skipped the rest, which
      // silently dropped a quant_matrix_extension (0x03) carrying custom/chroma
      // dequant matrices — leaving the default matrix and corrupting every AC block.
      let code: number = this.bits.findNextStartCode();
      while (code === START.EXTENSION || code === START.USER_DATA) {
        if (code === START.EXTENSION) {
          const extId = this.bits.read(4);
          if (extId === 0x08) this.decodePictureCodingExtension();
          else if (extId === 0x03) this.decodeQuantMatrixExtension();
          // other extension ids: leave unparsed; findNextStartCode skips their data
        }
        code = this.bits.findNextStartCode();
      }
      while (code >= START.SLICE_FIRST && code <= START.SLICE_LAST) {
        this.decodeSlice(code & 0xff);
        code = this.bits.findNextStartCode();
      }
      if (code !== -1) this.bits.rewind(32);
    }

    // Display reordering: I/P frames hold back previous anchor; B frames emit immediately
    if (this.pictureType === PICTURE_TYPE.INTRA || this.pictureType === PICTURE_TYPE.PREDICTIVE) {
      if (this.hasHeldAnchor) {
        // Emit the PREVIOUSLY held anchor (in forwardY). Its keyframe-ness is heldAnchorIsKeyframe,
        // not the current pictureType. While suppressing after a reset, drop everything until this
        // is the random-access keyframe.
        const key = this.heldAnchorIsKeyframe;
        if (!this.suppressUntilKeyframe || key) {
          this.emitFrame(this.forwardY, this.forwardCb, this.forwardCr, key);
          if (key) this.suppressUntilKeyframe = false;
        }
      }
      this.hasHeldAnchor = true;
      this.heldAnchorIsKeyframe = this.pictureType === PICTURE_TYPE.INTRA; // the frame now held
      // Rotate buffers: current → forward, forward → backward, backward → current
      let tmp = this.backwardY; let tmp32 = this.backwardY32;
      this.backwardY = this.forwardY; this.backwardY32 = this.forwardY32;
      this.forwardY  = this.currentY; this.forwardY32  = this.currentY32;
      this.currentY  = tmp;           this.currentY32  = tmp32;

      tmp = this.backwardCr; tmp32 = this.backwardCr32;
      this.backwardCr = this.forwardCr; this.backwardCr32 = this.forwardCr32;
      this.forwardCr  = this.currentCr; this.forwardCr32  = this.currentCr32;
      this.currentCr  = tmp;            this.currentCr32  = tmp32;

      tmp = this.backwardCb; tmp32 = this.backwardCb32;
      this.backwardCb = this.forwardCb; this.backwardCb32 = this.forwardCb32;
      this.forwardCb  = this.currentCb; this.forwardCb32  = this.currentCb32;
      this.currentCb  = tmp;            this.currentCb32  = tmp32;
    } else {
      // B-frame: emit immediately, no rotation — unless still suppressing leading B's after a reset
      // (those reference a previous GOP we no longer have).
      if (!this.suppressUntilKeyframe) {
        this.emitFrame(this.currentY, this.currentCb, this.currentCr, false);
      }
    }
  }

  private emitFrame(y: Uint8ClampedArray, cb: Uint8ClampedArray, cr: Uint8ClampedArray, isKeyframe: boolean): void {
    this.onFrame({
      y, cb, cr,
      codedWidth: this.codedWidth,
      codedHeight: this.codedHeight,
      width: this.width,
      height: this.height,
      chromaFormat: this.chromaFormat,
      isKeyframe,
    });
  }

  private decodePictureCodingExtension(): void {
    this.fCode[0][0] = this.bits.read(4);
    this.fCode[0][1] = this.bits.read(4);
    this.fCode[1][0] = this.bits.read(4);
    this.fCode[1][1] = this.bits.read(4);
    this.intraDcPrecision = this.bits.read(2);
    this.pictureStructure = this.bits.read(2); // picture_structure (3 = frame)
    this.bits.skip(1); // top_field_first
    this.framePredFrameDct = this.bits.read(1) === 1; // frame_pred_frame_dct
    this.concealmentMotionVectors = this.bits.read(1) === 1;
    this.qScaleType    = this.bits.read(1) === 1;
    this.intraVlcFormat = this.bits.read(1) === 1;
    this.alternateScan = this.bits.read(1) === 1;
    this.bits.skip(3); // repeat_first_field, chroma_420_type, progressive_frame
  }

  /**
   * quant_matrix_extension (ISO 13818-2 6.2.3.2): loads any of the four dequant
   * matrices. Matrices are transmitted in zig-zag (default) scan order. If a
   * chroma matrix is not loaded it follows the corresponding luma matrix.
   * extension_start_code_identifier (0x03) has already been consumed.
   */
  private decodeQuantMatrixExtension(): void {
    if (this.bits.read(1)) { // load_intra_quantiser_matrix
      for (let i = 0; i < 64; i++) this.customIntraQuantMatrix[ZIG_ZAG[i]] = this.bits.read(8);
      this.intraQuantMatrix = this.customIntraQuantMatrix;
      this.chromaIntraQuantMatrix = this.customIntraQuantMatrix; // default chroma follows luma
    }
    if (this.bits.read(1)) { // load_non_intra_quantiser_matrix
      for (let i = 0; i < 64; i++) this.customNonIntraQuantMatrix[ZIG_ZAG[i]] = this.bits.read(8);
      this.nonIntraQuantMatrix = this.customNonIntraQuantMatrix;
      this.chromaNonIntraQuantMatrix = this.customNonIntraQuantMatrix;
    }
    if (this.bits.read(1)) { // load_chroma_intra_quantiser_matrix
      for (let i = 0; i < 64; i++) this.customChromaIntraQuantMatrix[ZIG_ZAG[i]] = this.bits.read(8);
      this.chromaIntraQuantMatrix = this.customChromaIntraQuantMatrix;
    }
    if (this.bits.read(1)) { // load_chroma_non_intra_quantiser_matrix
      for (let i = 0; i < 64; i++) this.customChromaNonIntraQuantMatrix[ZIG_ZAG[i]] = this.bits.read(8);
      this.chromaNonIntraQuantMatrix = this.customChromaNonIntraQuantMatrix;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: slice / macroblock / block
  // -------------------------------------------------------------------------

  private decodeSlice(slice: number): void {
    this.sliceBegin = true;
    this.macroblockAddress = (slice - 1) * this.mbWidth - 1;
    this.motionFwH = this.motionFwHPrev = 0;
    this.motionFwV = this.motionFwVPrev = 0;
    this.motionBwH = this.motionBwHPrev = 0;
    this.motionBwV = this.motionBwVPrev = 0;
    this.resetPMV();
    const dcInit = 128 << this.intraDcPrecision;
    this.dcPredictorY  = dcInit;
    this.dcPredictorCr = dcInit;
    this.dcPredictorCb = dcInit;
    const qsCode = this.bits.read(5);
    this.quantizerScale = this.qScaleType ? NON_LINEAR_QUANTIZER_SCALE[qsCode] : qsCode;
    while (this.bits.read(1)) this.bits.skip(8); // extra slice data
    let mbCount = 0;
    // A slice never spans more than one MB row, so it can hold at most mbWidth MBs.
    // The cap stops a desynced slice from over-reading into following rows (which would
    // corrupt them and inflate the MB count); the picture loop resyncs at the next slice.
    do { this.decodeMacroblock(); mbCount++; } while (mbCount < this.mbWidth && !this.bits.nextBytesAreStartCode());
  }

  private readHuffman(codeTable: Int32Array | Int16Array | Int8Array): number {
    let state = 0;
    do {
      state = codeTable[state + this.bits.read(1)];
    } while (state >= 0 && codeTable[state] !== 0);
    return codeTable[state + 2];
  }

  private decodeMacroblock(): void {
    let increment = 0;
    let t = this.readHuffman(MACROBLOCK_ADDRESS_INCREMENT);
    while (t === 34) t = this.readHuffman(MACROBLOCK_ADDRESS_INCREMENT);
    while (t === 35) { increment += 33; t = this.readHuffman(MACROBLOCK_ADDRESS_INCREMENT); }
    increment += t;

    if (this.sliceBegin) {
      this.sliceBegin = false;
      this.macroblockAddress += increment;
    } else {
      if (this.macroblockAddress + increment >= this.mbSize) return;
      if (increment > 1) {
        this.dcPredictorY = this.dcPredictorCr = this.dcPredictorCb = 128 << this.intraDcPrecision;
        if (this.pictureType === PICTURE_TYPE.PREDICTIVE) {
          // Skipped P macroblock (ISO 13818-2 7.6.6): zero MV, frame-based prediction.
          this.motionFwH = this.motionFwHPrev = 0;
          this.motionFwV = this.motionFwVPrev = 0;
          this.resetPMV();
          this.mvFormatField = false;
          this.macroblockMotFw = true;
          this.macroblockMotBw = false;
        }
        // Skipped B macroblock: repeat the previous MB's motion vectors and prediction
        // mode (PMV / fieldSelect / mvFormatField / motion flags are preserved as-is).
      }
      while (increment > 1) {
        this.macroblockAddress++;
        this.mbRow = (this.macroblockAddress / this.mbWidth) | 0;
        this.mbCol = this.macroblockAddress % this.mbWidth;
        if (this.isMPEG2) {
          this.formInterPrediction();
        } else if (this.pictureType === PICTURE_TYPE.B) {
          if (this.macroblockMotFw) this.copyMacroblock(this.motionFwH, this.motionFwV, this.backwardY, this.backwardCr, this.backwardCb);
          if (this.macroblockMotBw) {
            if (this.macroblockMotFw) this.copyMacroblockInterpolated(this.motionFwH, this.motionFwV, this.motionBwH, this.motionBwV);
            else this.copyMacroblock(this.motionBwH, this.motionBwV, this.forwardY, this.forwardCr, this.forwardCb);
          }
        } else {
          this.copyMacroblock(this.motionFwH, this.motionFwV, this.forwardY, this.forwardCr, this.forwardCb);
        }
        increment--;
      }
      this.macroblockAddress++;
    }
    this.mbRow = (this.macroblockAddress / this.mbWidth) | 0;
    this.mbCol = this.macroblockAddress % this.mbWidth;

    const mbTable = MACROBLOCK_TYPE[this.pictureType]!;
    this.macroblockType = this.readHuffman(mbTable);
    this.macroblockIntra  = (this.macroblockType & 0x01) !== 0;
    this.macroblockMotFw  = (this.macroblockType & 0x08) !== 0;
    this.macroblockMotBw  = (this.macroblockType & 0x04) !== 0;

    // macroblock_modes (ISO 13818-2 6.3.17.1): frame/field_motion_type is coded
    // BEFORE dct_type. MPEG-1 has neither bit; the existing MPEG-1 path is untouched.
    if (this.isMPEG2) this.readMotionType();

    // dct_type (ISO 13818-2 6.3.17.1): present in a FRAME picture when
    // frame_pred_frame_dct == 0 and the macroblock is intra or has a coded pattern.
    // MPEG-1 has no such bit; failing to consume it desyncs the bitstream by 1 bit/MB.
    this.dctType = false;
    if (this.pictureStructure === 3 && !this.framePredFrameDct &&
        (this.macroblockIntra || (this.macroblockType & 0x02) !== 0)) {
      this.dctType = this.bits.read(1) === 1;
    }

    if ((this.macroblockType & 0x10) !== 0) {
      const qsCode = this.bits.read(5);
      this.quantizerScale = this.qScaleType ? NON_LINEAR_QUANTIZER_SCALE[qsCode] : qsCode;
    }

    if (this.macroblockIntra) {
      // Intra MB with concealment_motion_vectors carries a forward MV + marker bit
      // (ISO 13818-2 6.3.17.2). Read it to stay bit-aligned, then reset predictors.
      if (this.isMPEG2 && this.concealmentMotionVectors) {
        this.readMotionVectors(0);
        this.bits.read(1); // marker_bit
      }
      this.motionFwH = this.motionFwHPrev = 0;
      this.motionFwV = this.motionFwVPrev = 0;
      this.motionBwH = this.motionBwHPrev = 0;
      this.motionBwV = this.motionBwVPrev = 0;
      this.resetPMV();
    } else {
      this.dcPredictorY = this.dcPredictorCr = this.dcPredictorCb = 128 << this.intraDcPrecision;
      if (this.isMPEG2) {
        if (this.pictureType === PICTURE_TYPE.B) {
          if (this.macroblockMotFw) this.readMotionVectors(0);
          if (this.macroblockMotBw) this.readMotionVectors(1);
        } else if (this.macroblockMotFw) {
          this.readMotionVectors(0);
        } else {
          // P-frame "No MC" macroblock (macroblock_motion_forward == 0): no motion
          // vectors in the bitstream; zero MV with predictors reset (ISO 13818-2 7.6.3.4).
          this.resetPMV();
        }
        this.formInterPrediction();
      } else if (this.pictureType === PICTURE_TYPE.B) {
        if (this.macroblockMotFw) this.decodeMotionVectorsFwd();
        if (this.macroblockMotBw) this.decodeMotionVectorsBwd();
        if (this.macroblockMotFw && this.macroblockMotBw) {
          this.copyMacroblockInterpolated(this.motionFwH, this.motionFwV, this.motionBwH, this.motionBwV);
        } else if (this.macroblockMotFw) {
          this.copyMacroblock(this.motionFwH, this.motionFwV, this.backwardY, this.backwardCr, this.backwardCb);
        } else if (this.macroblockMotBw) {
          this.copyMacroblock(this.motionBwH, this.motionBwV, this.forwardY, this.forwardCr, this.forwardCb);
        }
      } else {
        this.decodeMotionVectorsFwd();
        this.copyMacroblock(this.motionFwH, this.motionFwV, this.forwardY, this.forwardCr, this.forwardCb);
      }
    }

    let cbp: number;
    if ((this.macroblockType & 0x02) !== 0) {
      cbp = this.readHuffman(CODE_BLOCK_PATTERN);
      if (this.chromaFormat === 2) cbp = (cbp << 2) | this.bits.read(2);
    } else {
      cbp = this.macroblockIntra ? (this.chromaFormat === 2 ? 0xff : 0x3f) : 0;
    }

    const numBlocks = this.chromaFormat === 2 ? 8 : 6;
    for (let block = 0, mask = (numBlocks === 8 ? 0x80 : 0x20); block < numBlocks; block++) {
      if ((cbp & mask) !== 0) this.decodeBlock(block);
      mask >>= 1;
    }
  }

  private decodeMotionVectorsFwd(): void {
    if (!this.macroblockMotFw && this.pictureType !== PICTURE_TYPE.PREDICTIVE) return;
    const fCodeH = this.fCode[0][0];
    const fCodeV = this.fCode[0][1];
    const rSizeH = fCodeH - 1;
    const rSizeV = fCodeV - 1;
    const fH = 1 << rSizeH;
    const fV = 1 << rSizeV;

    if (!this.macroblockMotFw) {
      if (this.pictureType === PICTURE_TYPE.PREDICTIVE) {
        this.motionFwH = this.motionFwHPrev = 0;
        this.motionFwV = this.motionFwVPrev = 0;
      }
      return;
    }

    let code = this.readHuffman(MOTION);
    let d = (code !== 0 && fH !== 1) ? (((Math.abs(code) - 1) << rSizeH) + this.bits.read(rSizeH) + 1) * (code < 0 ? -1 : 1) : code;
    this.motionFwHPrev += d;
    if (this.motionFwHPrev > (fH << 4) - 1) this.motionFwHPrev -= fH << 5;
    else if (this.motionFwHPrev < -(fH << 4)) this.motionFwHPrev += fH << 5;
    this.motionFwH = this.motionFwHPrev;
    if (!this.isMPEG2 && this.fullPelForward) this.motionFwH <<= 1;

    code = this.readHuffman(MOTION);
    d = (code !== 0 && fV !== 1) ? (((Math.abs(code) - 1) << rSizeV) + this.bits.read(rSizeV) + 1) * (code < 0 ? -1 : 1) : code;
    this.motionFwVPrev += d;
    if (this.motionFwVPrev > (fV << 4) - 1) this.motionFwVPrev -= fV << 5;
    else if (this.motionFwVPrev < -(fV << 4)) this.motionFwVPrev += fV << 5;
    this.motionFwV = this.motionFwVPrev;
    if (!this.isMPEG2 && this.fullPelForward) this.motionFwV <<= 1;
  }

  private decodeMotionVectorsBwd(): void {
    if (!this.macroblockMotBw) return;
    const fCodeH = this.fCode[1][0];
    const fCodeV = this.fCode[1][1];
    const rSizeH = fCodeH - 1;
    const rSizeV = fCodeV - 1;
    const fH = 1 << rSizeH;
    const fV = 1 << rSizeV;

    let code = this.readHuffman(MOTION);
    let d = (code !== 0 && fH !== 1) ? (((Math.abs(code) - 1) << rSizeH) + this.bits.read(rSizeH) + 1) * (code < 0 ? -1 : 1) : code;
    this.motionBwHPrev += d;
    if (this.motionBwHPrev > (fH << 4) - 1) this.motionBwHPrev -= fH << 5;
    else if (this.motionBwHPrev < -(fH << 4)) this.motionBwHPrev += fH << 5;
    this.motionBwH = this.motionBwHPrev;

    code = this.readHuffman(MOTION);
    d = (code !== 0 && fV !== 1) ? (((Math.abs(code) - 1) << rSizeV) + this.bits.read(rSizeV) + 1) * (code < 0 ? -1 : 1) : code;
    this.motionBwVPrev += d;
    if (this.motionBwVPrev > (fV << 4) - 1) this.motionBwVPrev -= fV << 5;
    else if (this.motionBwVPrev < -(fV << 4)) this.motionBwVPrev += fV << 5;
    this.motionBwV = this.motionBwVPrev;
  }

  // -------------------------------------------------------------------------
  // MPEG-2 motion compensation (P/B frames). ISO 13818-2 7.6.
  // The MPEG-1 routines above are kept verbatim for the !isMPEG2 path.
  // -------------------------------------------------------------------------

  private resetPMV(): void {
    this.PMV[0][0][0] = this.PMV[0][0][1] = 0;
    this.PMV[0][1][0] = this.PMV[0][1][1] = 0;
    this.PMV[1][0][0] = this.PMV[1][0][1] = 0;
    this.PMV[1][1][0] = this.PMV[1][1][1] = 0;
  }

  /**
   * macroblock_modes: frame_motion_type / field_motion_type (ISO 13818-2 6.3.17.1,
   * Tables 6-17 / 6-18). Sets mvCount / mvFormatField / mvScale / dmv. Reads the 2-bit
   * field only when the MB has motion and frame_pred_frame_dct is off in a frame picture.
   */
  private readMotionType(): void {
    // Defaults — also used by intra MBs carrying concealment motion vectors (frame format).
    this.mvCount = 1; this.mvFormatField = false; this.mvScale = false; this.dmv = false;
    if (!this.macroblockMotFw && !this.macroblockMotBw) return;

    const framePic = this.pictureStructure === 3;
    if (framePic && this.framePredFrameDct) {
      return;                          // frame-based, 1 MV, no bits in the stream
    }
    const mt = this.bits.read(2);
    if (framePic) {
      switch (mt) {
        case 1: this.mvCount = 2; this.mvFormatField = true;  this.mvScale = true;  break; // field
        case 2: this.mvCount = 1; this.mvFormatField = false; this.mvScale = false; break; // frame
        case 3: this.mvCount = 1; this.mvFormatField = true;  this.mvScale = true;  this.dmv = true; break; // dual-prime
        default: break; // 0 reserved
      }
    } else {
      switch (mt) {
        case 1: this.mvCount = 1; this.mvFormatField = true; break;                 // field
        case 2: this.mvCount = 2; this.mvFormatField = true; break;                 // 16×8
        case 3: this.mvCount = 1; this.mvFormatField = true; this.dmv = true; break;// dual-prime
        default: this.mvCount = 1; this.mvFormatField = true; break;
      }
    }
  }

  /** motion_vectors(s) — s: 0 = forward, 1 = backward (ISO 13818-2 6.3.17.3). */
  private readMotionVectors(s: 0 | 1): void {
    if (this.mvCount === 1) {
      if (this.mvFormatField && !this.dmv) this.fieldSelect[0][s] = this.bits.read(1);
      this.decodeMV(0, s);
      // A single motion vector updates BOTH predictors (ISO 13818-2 7.6.3.5) so that a
      // following field-predicted MB has a valid PMV[1].
      this.PMV[1][s][0] = this.PMV[0][s][0];
      this.PMV[1][s][1] = this.PMV[0][s][1];
      // Dual-prime: approximate as same-parity field prediction (top MB field ← top
      // reference field, bottom ← bottom) with the single decoded vector. Exact for the
      // dmv=0 / static case; full dual-prime averaging with the opposite field is TODO.
      if (this.dmv) { this.fieldSelect[0][s] = 0; this.fieldSelect[1][s] = 1; }
    } else {
      this.fieldSelect[0][s] = this.bits.read(1);
      this.decodeMV(0, s);
      this.fieldSelect[1][s] = this.bits.read(1);
      this.decodeMV(1, s);
    }
  }

  /** motion_vector(r, s): horizontal then vertical, with field-in-frame scaling. */
  private decodeMV(r: 0 | 1, s: 0 | 1): void {
    this.decodeMVComponent(r, s, 0);              // horizontal
    if (this.dmv) this.readDmvector();            // dmvector[0] (dual-prime)
    if (this.mvScale) this.PMV[r][s][1] >>= 1;    // frame predictor → field units
    this.decodeMVComponent(r, s, 1);              // vertical
    if (this.dmv) this.readDmvector();            // dmvector[1] (dual-prime)
    if (this.mvScale) this.PMV[r][s][1] <<= 1;    // field result → frame units for storage
  }

  /** dmvector[t] (ISO 13818-2 Table B.11): '0'→0, '10'→+1, '11'→−1. */
  private readDmvector(): number {
    if (this.bits.read(1) === 0) return 0;
    return this.bits.read(1) === 0 ? 1 : -1;
  }

  /** Reconstruct one motion vector component into PMV[r][s][t] (ISO 13818-2 7.6.3.1). */
  private decodeMVComponent(r: 0 | 1, s: 0 | 1, t: 0 | 1): void {
    const rSize = this.fCode[s][t] - 1;
    const motionCode = this.readHuffman(MOTION); // signed motion_code
    const lim = 16 << rSize;
    let vec = this.PMV[r][s][t];
    if (motionCode > 0) {
      const residual = rSize > 0 ? this.bits.read(rSize) : 0;
      vec += ((motionCode - 1) << rSize) + residual + 1;
      if (vec >= lim) vec -= lim + lim;
    } else if (motionCode < 0) {
      const residual = rSize > 0 ? this.bits.read(rSize) : 0;
      vec -= ((-motionCode - 1) << rSize) + residual + 1;
      if (vec < -lim) vec += lim + lim;
    }
    this.PMV[r][s][t] = vec;
  }

  /** Dispatch the reconstructed prediction into currentY/Cb/Cr for the current MB. */
  private formInterPrediction(): void {
    if (this.pictureType === PICTURE_TYPE.B) {
      const both = this.macroblockMotFw && this.macroblockMotBw;
      if (this.mvFormatField) {
        if (this.macroblockMotFw) this.predictField(0, this.backwardY, this.backwardCr, this.backwardCb, false);
        if (this.macroblockMotBw) this.predictField(1, this.forwardY, this.forwardCr, this.forwardCb, both);
      } else if (both) {
        this.copyMacroblockInterpolated(this.PMV[0][0][0], this.PMV[0][0][1], this.PMV[0][1][0], this.PMV[0][1][1]);
      } else if (this.macroblockMotFw) {
        this.copyMacroblock(this.PMV[0][0][0], this.PMV[0][0][1], this.backwardY, this.backwardCr, this.backwardCb);
      } else if (this.macroblockMotBw) {
        this.copyMacroblock(this.PMV[0][1][0], this.PMV[0][1][1], this.forwardY, this.forwardCr, this.forwardCb);
      }
    } else {
      // P frame: forward prediction from the most recent anchor (forwardY).
      if (this.mvFormatField) {
        this.predictField(0, this.forwardY, this.forwardCr, this.forwardCb, false);
      } else {
        this.copyMacroblock(this.PMV[0][0][0], this.PMV[0][0][1], this.forwardY, this.forwardCr, this.forwardCb);
      }
    }
  }

  /**
   * Field-based prediction in a FRAME picture (ISO 13818-2 7.6.4). Two motion vectors:
   * r=0 predicts the macroblock's top field (even lines), r=1 the bottom field (odd lines).
   * Each selects a reference field (top/bottom) via motion_vertical_field_select. The
   * stored vertical PMV is in frame units (×2); the field-unit displacement is PMV>>1.
   * Vertical half-pel interpolates between adjacent field lines (2 frame rows apart).
   * `accumulate` averages with the existing prediction (B-frame fwd+bwd blend).
   */
  private predictField(
    s: 0 | 1,
    refY: Uint8ClampedArray, refCr: Uint8ClampedArray, refCb: Uint8ClampedArray,
    accumulate: boolean,
  ): void {
    const W = this.codedWidth;
    const H = this.codedHeight;
    const cw = this.halfWidth;                 // chroma plane width
    const is422 = this.chromaFormat === 2;
    const cH = is422 ? H : (H >> 1);           // chroma plane height
    const curY = this.currentY, curCr = this.currentCr, curCb = this.currentCb;

    for (let r = 0; r < 2; r++) {              // r=0 → MB top field, r=1 → MB bottom field
      const mvh = this.PMV[r][s][0];
      const mvv = this.PMV[r][s][1] >> 1;      // frame units → field units
      const srcParity = this.fieldSelect[r][s];
      const dstParity = r;

      // ---- luma: 16 wide × 8 field lines ----
      const intH = mvh >> 1, halfH = mvh & 1;
      const intV = mvv >> 1, halfV = mvv & 1;
      const colBase = (this.mbCol << 4) + intH;
      const dstColBase = this.mbCol << 4;
      for (let m = 0; m < 8; m++) {
        const dstRow = (this.mbRow << 4) + (m << 1) + dstParity;
        if (dstRow >= H) break;
        const fieldLine = (this.mbRow << 3) + m + intV;
        let r0 = (fieldLine << 1) + srcParity;
        r0 = r0 < 0 ? 0 : r0 >= H ? H - 1 : r0;
        let r1 = halfV ? r0 + 2 : r0;
        if (r1 >= H) r1 = H - 1;
        const o0 = r0 * W, o1 = r1 * W, dstBase = dstRow * W + dstColBase;
        for (let n = 0; n < 16; n++) {
          let c0 = colBase + n;
          c0 = c0 < 0 ? 0 : c0 >= W ? W - 1 : c0;
          const c1 = halfH && c0 + 1 < W ? c0 + 1 : c0;
          let val: number;
          if (halfH && halfV) val = (refY[o0 + c0] + refY[o0 + c1] + refY[o1 + c0] + refY[o1 + c1] + 2) >> 2;
          else if (halfH)     val = (refY[o0 + c0] + refY[o0 + c1] + 1) >> 1;
          else if (halfV)     val = (refY[o0 + c0] + refY[o1 + c0] + 1) >> 1;
          else                val = refY[o0 + c0];
          const di = dstBase + n;
          curY[di] = accumulate ? ((curY[di] + val + 1) >> 1) : val;
        }
      }

      // ---- chroma ----
      // 4:2:2 → 8 wide × 8 field lines, horizontal MV halved, vertical unchanged.
      // 4:2:0 → 8 wide × 4 field lines, both MV components halved.
      const cmvh = (mvh / 2) | 0;
      const cmvv = is422 ? mvv : ((mvv / 2) | 0);
      const cFieldRows = is422 ? 8 : 4;
      const cMbRowOrigin = is422 ? (this.mbRow << 3) : (this.mbRow << 2); // field-line origin
      const cDstRowOrigin = is422 ? (this.mbRow << 4) : (this.mbRow << 3);
      const cIntH = cmvh >> 1, cHalfH = cmvh & 1;
      const cIntV = cmvv >> 1, cHalfV = cmvv & 1;
      const cColBase = (this.mbCol << 3) + cIntH;
      const cDstColBase = this.mbCol << 3;
      for (let m = 0; m < cFieldRows; m++) {
        const dstRow = cDstRowOrigin + (m << 1) + dstParity;
        if (dstRow >= cH) break;
        const fieldLine = cMbRowOrigin + m + cIntV;
        let r0 = (fieldLine << 1) + srcParity;
        r0 = r0 < 0 ? 0 : r0 >= cH ? cH - 1 : r0;
        let r1 = cHalfV ? r0 + 2 : r0;
        if (r1 >= cH) r1 = cH - 1;
        const o0 = r0 * cw, o1 = r1 * cw, dstBase = dstRow * cw + cDstColBase;
        for (let n = 0; n < 8; n++) {
          let c0 = cColBase + n;
          c0 = c0 < 0 ? 0 : c0 >= cw ? cw - 1 : c0;
          const c1 = cHalfH && c0 + 1 < cw ? c0 + 1 : c0;
          let cr: number, cb: number;
          if (cHalfH && cHalfV) {
            cr = (refCr[o0 + c0] + refCr[o0 + c1] + refCr[o1 + c0] + refCr[o1 + c1] + 2) >> 2;
            cb = (refCb[o0 + c0] + refCb[o0 + c1] + refCb[o1 + c0] + refCb[o1 + c1] + 2) >> 2;
          } else if (cHalfH) {
            cr = (refCr[o0 + c0] + refCr[o0 + c1] + 1) >> 1;
            cb = (refCb[o0 + c0] + refCb[o0 + c1] + 1) >> 1;
          } else if (cHalfV) {
            cr = (refCr[o0 + c0] + refCr[o1 + c0] + 1) >> 1;
            cb = (refCb[o0 + c0] + refCb[o1 + c0] + 1) >> 1;
          } else {
            cr = refCr[o0 + c0]; cb = refCb[o0 + c0];
          }
          const di = dstBase + n;
          curCr[di] = accumulate ? ((curCr[di] + cr + 1) >> 1) : cr;
          curCb[di] = accumulate ? ((curCb[di] + cb + 1) >> 1) : cb;
        }
      }
    }
  }

  private copyMacroblock(
    motionH: number, motionV: number,
    sY: Uint8ClampedArray, sCr: Uint8ClampedArray, sCb: Uint8ClampedArray,
  ): void {
    const dY = this.currentY32;
    const dCb = this.currentCb32;
    const dCr = this.currentCr32;
    let width = this.codedWidth;
    let scan = width - 16;

    let H = motionH >> 1;
    let V = motionV >> 1;
    let oddH = (motionH & 1) === 1;
    let oddV = (motionV & 1) === 1;

    let src = ((this.mbRow << 4) + V) * width + (this.mbCol << 4) + H;
    let dest = (this.mbRow * width + this.mbCol) << 2;
    let last = dest + (width << 2);

    if (oddH) {
      if (oddV) {
        while (dest < last) {
          let y1 = sY[src] + sY[src + width]; src++;
          for (let x = 0; x < 4; x++) {
            let y2 = sY[src] + sY[src + width]; src++;
            let y = (((y1 + y2 + 2) >> 2) & 0xff);
            y1 = sY[src] + sY[src + width]; src++;
            y |= (((y1 + y2 + 2) << 6) & 0xff00);
            y2 = sY[src] + sY[src + width]; src++;
            y |= (((y1 + y2 + 2) << 14) & 0xff0000);
            y1 = sY[src] + sY[src + width]; src++;
            y |= (((y1 + y2 + 2) << 22) & 0xff000000);
            dY[dest++] = y;
          }
          dest += scan >> 2; src += scan - 1;
        }
      } else {
        while (dest < last) {
          let y1 = sY[src++];
          for (let x = 0; x < 4; x++) {
            let y2 = sY[src++];
            let y = (((y1 + y2 + 1) >> 1) & 0xff);
            y1 = sY[src++];
            y |= (((y1 + y2 + 1) << 7) & 0xff00);
            y2 = sY[src++];
            y |= (((y1 + y2 + 1) << 15) & 0xff0000);
            y1 = sY[src++];
            y |= (((y1 + y2 + 1) << 23) & 0xff000000);
            dY[dest++] = y;
          }
          dest += scan >> 2; src += scan - 1;
        }
      }
    } else {
      if (oddV) {
        while (dest < last) {
          for (let x = 0; x < 4; x++) {
            let y = (((sY[src] + sY[src + width] + 1) >> 1) & 0xff); src++;
            y |= (((sY[src] + sY[src + width] + 1) << 7) & 0xff00); src++;
            y |= (((sY[src] + sY[src + width] + 1) << 15) & 0xff0000); src++;
            y |= (((sY[src] + sY[src + width] + 1) << 23) & 0xff000000); src++;
            dY[dest++] = y;
          }
          dest += scan >> 2; src += scan;
        }
      } else {
        while (dest < last) {
          for (let x = 0; x < 4; x++) {
            let y = sY[src]; src++;
            y |= sY[src] << 8; src++;
            y |= sY[src] << 16; src++;
            y |= sY[src] << 24; src++;
            dY[dest++] = y;
          }
          dest += scan >> 2; src += scan;
        }
      }
    }

    // Chrominance
    width = this.halfWidth;
    scan = width - 8;

    if (this.chromaFormat === 2) {
      const cH = (motionH / 2) >> 1;
      const cV = motionV >> 1;
      const cOddH = ((motionH / 2) & 1) === 1;
      const cOddV = (motionV & 1) === 1;
      let cSrc = ((this.mbRow << 4) + cV) * width + (this.mbCol << 3) + cH;
      let cDest = (this.mbRow << 4) * width + (this.mbCol << 3);
      const cLast = cDest + (width << 4);
      const dCrB = this.currentCr; const dCbB = this.currentCb;
      if (cOddH && cOddV) {
        while (cDest < cLast) { for (let xi = 0; xi < 8; xi++, cSrc++, cDest++) { dCrB[cDest] = (sCr[cSrc]+sCr[cSrc+1]+sCr[cSrc+width]+sCr[cSrc+width+1]+2)>>2; dCbB[cDest] = (sCb[cSrc]+sCb[cSrc+1]+sCb[cSrc+width]+sCb[cSrc+width+1]+2)>>2; } cSrc += width-8; cDest += width-8; }
      } else if (cOddH) {
        while (cDest < cLast) { for (let xi = 0; xi < 8; xi++, cSrc++, cDest++) { dCrB[cDest] = (sCr[cSrc]+sCr[cSrc+1]+1)>>1; dCbB[cDest] = (sCb[cSrc]+sCb[cSrc+1]+1)>>1; } cSrc += width-8; cDest += width-8; }
      } else if (cOddV) {
        while (cDest < cLast) { for (let xi = 0; xi < 8; xi++, cSrc++, cDest++) { dCrB[cDest] = (sCr[cSrc]+sCr[cSrc+width]+1)>>1; dCbB[cDest] = (sCb[cSrc]+sCb[cSrc+width]+1)>>1; } cSrc += width-8; cDest += width-8; }
      } else {
        while (cDest < cLast) { for (let xi = 0; xi < 8; xi++, cSrc++, cDest++) { dCrB[cDest] = sCr[cSrc]; dCbB[cDest] = sCb[cSrc]; } cSrc += width-8; cDest += width-8; }
      }
      return;
    }

    H = (motionH / 2) >> 1;
    V = (motionV / 2) >> 1;
    oddH = ((motionH / 2) & 1) === 1;
    oddV = ((motionV / 2) & 1) === 1;

    src  = ((this.mbRow << 3) + V) * width + (this.mbCol << 3) + H;
    dest = (this.mbRow * width + this.mbCol) << 1;
    last = dest + (width << 1);

    if (oddH) {
      if (oddV) {
        while (dest < last) {
          let cr1 = sCr[src] + sCr[src + width]; let cb1 = sCb[src] + sCb[src + width]; src++;
          for (let x = 0; x < 2; x++) {
            let cr2 = sCr[src] + sCr[src + width]; let cb2 = sCb[src] + sCb[src + width]; src++;
            let cr = (((cr1 + cr2 + 2) >> 2) & 0xff); let cb = (((cb1 + cb2 + 2) >> 2) & 0xff);
            cr1 = sCr[src] + sCr[src + width]; cb1 = sCb[src] + sCb[src + width]; src++;
            cr |= (((cr1 + cr2 + 2) << 6) & 0xff00); cb |= (((cb1 + cb2 + 2) << 6) & 0xff00);
            cr2 = sCr[src] + sCr[src + width]; cb2 = sCb[src] + sCb[src + width]; src++;
            cr |= (((cr1 + cr2 + 2) << 14) & 0xff0000); cb |= (((cb1 + cb2 + 2) << 14) & 0xff0000);
            cr1 = sCr[src] + sCr[src + width]; cb1 = sCb[src] + sCb[src + width]; src++;
            cr |= (((cr1 + cr2 + 2) << 22) & 0xff000000); cb |= (((cb1 + cb2 + 2) << 22) & 0xff000000);
            dCr[dest] = cr; dCb[dest] = cb; dest++;
          }
          dest += scan >> 2; src += scan - 1;
        }
      } else {
        while (dest < last) {
          let cr1 = sCr[src]; let cb1 = sCb[src]; src++;
          for (let x = 0; x < 2; x++) {
            let cr2 = sCr[src]; let cb2 = sCb[src++];
            let cr = (((cr1 + cr2 + 1) >> 1) & 0xff); let cb = (((cb1 + cb2 + 1) >> 1) & 0xff);
            cr1 = sCr[src]; cb1 = sCb[src++];
            cr |= (((cr1 + cr2 + 1) << 7) & 0xff00); cb |= (((cb1 + cb2 + 1) << 7) & 0xff00);
            cr2 = sCr[src]; cb2 = sCb[src++];
            cr |= (((cr1 + cr2 + 1) << 15) & 0xff0000); cb |= (((cb1 + cb2 + 1) << 15) & 0xff0000);
            cr1 = sCr[src]; cb1 = sCb[src++];
            cr |= (((cr1 + cr2 + 1) << 23) & 0xff000000); cb |= (((cb1 + cb2 + 1) << 23) & 0xff000000);
            dCr[dest] = cr; dCb[dest] = cb; dest++;
          }
          dest += scan >> 2; src += scan - 1;
        }
      }
    } else {
      if (oddV) {
        while (dest < last) {
          for (let x = 0; x < 2; x++) {
            let cr = (((sCr[src] + sCr[src + width] + 1) >> 1) & 0xff); let cb = (((sCb[src] + sCb[src + width] + 1) >> 1) & 0xff); src++;
            cr |= (((sCr[src] + sCr[src + width] + 1) << 7) & 0xff00); cb |= (((sCb[src] + sCb[src + width] + 1) << 7) & 0xff00); src++;
            cr |= (((sCr[src] + sCr[src + width] + 1) << 15) & 0xff0000); cb |= (((sCb[src] + sCb[src + width] + 1) << 15) & 0xff0000); src++;
            cr |= (((sCr[src] + sCr[src + width] + 1) << 23) & 0xff000000); cb |= (((sCb[src] + sCb[src + width] + 1) << 23) & 0xff000000); src++;
            dCr[dest] = cr; dCb[dest] = cb; dest++;
          }
          dest += scan >> 2; src += scan;
        }
      } else {
        while (dest < last) {
          for (let x = 0; x < 2; x++) {
            let cr = sCr[src]; let cb = sCb[src]; src++;
            cr |= sCr[src] << 8; cb |= sCb[src] << 8; src++;
            cr |= sCr[src] << 16; cb |= sCb[src] << 16; src++;
            cr |= sCr[src] << 24; cb |= sCb[src] << 24; src++;
            dCr[dest] = cr; dCb[dest] = cb; dest++;
          }
          dest += scan >> 2; src += scan;
        }
      }
    }
  }

  private copyMacroblockInterpolated(fwdH: number, fwdV: number, bwdH: number, bwdV: number): void {
    this.copyMacroblock(fwdH, fwdV, this.backwardY, this.backwardCr, this.backwardCb);
    const width = this.codedWidth;
    const fH = bwdH >> 1; const fV = bwdV >> 1;
    const oddH = (bwdH & 1) === 1; const oddV = (bwdV & 1) === 1;
    const sY = this.forwardY; const sCr = this.forwardCr; const sCb = this.forwardCb;
    const dY = this.currentY; const dCr = this.currentCr; const dCb = this.currentCb;
    const rowBase = this.mbRow << 4; const colBase = this.mbCol << 4;
    const srcBase = (rowBase + fV) * width + colBase + fH;
    const destBase = rowBase * width + colBase;
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const s = srcBase + row * width + col; const d = destBase + row * width + col;
        let val: number;
        if (oddH && oddV) val = (sY[s] + sY[s+1] + sY[s+width] + sY[s+width+1] + 2) >> 2;
        else if (oddH) val = (sY[s] + sY[s+1] + 1) >> 1;
        else if (oddV) val = (sY[s] + sY[s+width] + 1) >> 1;
        else val = sY[s];
        dY[d] = (dY[d] + val + 1) >> 1;
      }
    }
    const hw = this.halfWidth;
    let cFH: number; let cFV: number; let cOddH: boolean; let cOddV: boolean; let cRowBase: number; let cChromaRows: number;
    if (this.chromaFormat === 2) {
      cFH = (bwdH / 2) >> 1; cFV = bwdV >> 1; cOddH = ((bwdH / 2) & 1) === 1; cOddV = (bwdV & 1) === 1; cRowBase = this.mbRow << 4; cChromaRows = 16;
    } else {
      cFH = (bwdH/2) >> 1; cFV = (bwdV/2) >> 1; cOddH = ((bwdH/2) & 1) === 1; cOddV = ((bwdV/2) & 1) === 1; cRowBase = this.mbRow << 3; cChromaRows = 8;
    }
    const cColBase = this.mbCol << 3;
    const cSrcBase = (cRowBase + cFV) * hw + cColBase + cFH;
    const cDestBase = cRowBase * hw + cColBase;
    for (let row = 0; row < cChromaRows; row++) {
      for (let col = 0; col < 8; col++) {
        const s = cSrcBase + row * hw + col; const d = cDestBase + row * hw + col;
        let cr: number; let cb: number;
        if (cOddH && cOddV) { cr = (sCr[s]+sCr[s+1]+sCr[s+hw]+sCr[s+hw+1]+2)>>2; cb = (sCb[s]+sCb[s+1]+sCb[s+hw]+sCb[s+hw+1]+2)>>2; }
        else if (cOddH)     { cr = (sCr[s]+sCr[s+1]+1)>>1; cb = (sCb[s]+sCb[s+1]+1)>>1; }
        else if (cOddV)     { cr = (sCr[s]+sCr[s+hw]+1)>>1; cb = (sCb[s]+sCb[s+hw]+1)>>1; }
        else                { cr = sCr[s]; cb = sCb[s]; }
        dCr[d] = (dCr[d] + cr + 1) >> 1; dCb[d] = (dCb[d] + cb + 1) >> 1;
      }
    }
  }

  private decodeBlock(block: number): void {
    let n = 0;
    let quantMatrix: Uint8Array;

    if (this.macroblockIntra) {
      let predictor: number;
      let dctSize: number;
      if (block < 4) {
        predictor = this.dcPredictorY;
        dctSize = this.readHuffman(DCT_DC_SIZE_LUMINANCE);
      } else {
        predictor = ((block & 1) === 0 ? this.dcPredictorCb : this.dcPredictorCr);
        dctSize = this.readHuffman(DCT_DC_SIZE_CHROMINANCE);
      }
      if (dctSize > 0) {
        const differential = this.bits.read(dctSize);
        this.blockData[0] = (differential & (1 << (dctSize - 1))) !== 0
          ? predictor + differential
          : predictor + ((-1 << dctSize) | (differential + 1));
      } else {
        this.blockData[0] = predictor;
      }
      if (block < 4) this.dcPredictorY = this.blockData[0];
      else if ((block & 1) === 0) this.dcPredictorCb = this.blockData[0];
      else this.dcPredictorCr = this.blockData[0];
      this.blockData[0] <<= (3 + 5 - this.intraDcPrecision);
      quantMatrix = block < 4 ? this.intraQuantMatrix : this.chromaIntraQuantMatrix;
      n = 1;
    } else {
      quantMatrix = block < 4 ? this.nonIntraQuantMatrix : this.chromaNonIntraQuantMatrix;
    }

    const zigZag = this.alternateScan ? ALTERNATE_SCAN : ZIG_ZAG;
    // B-15 (intra_vlc_format=1) applies only to intra-coded blocks.
    const useB15 = this.intraVlcFormat && this.macroblockIntra;
    const dctCoeffTable = useB15 ? DCT_COEFF_B15 : DCT_COEFF_B14;
    const isMPEG2 = this.isMPEG2;
    const isIntra = this.macroblockIntra;
    const qs = this.quantizerScale;
    let mismatchParity = 0;

    // For non-intra blocks the FIRST coefficient is coded with the dct_coeff_first VLC:
    // a leading '1' means (run 0, level ±1) — '1s' (2 bits), and EOB cannot occur here.
    // All other first-coefficient codes start with '0' and are identical to dct_coeff_next,
    // so we decode them with the same table. Intra blocks start at n=1 (after DC) and use
    // dct_coeff_next throughout, so firstCoeff is false for them.
    let firstCoeff = !isIntra;
    while (true) {
      let run = 0;
      let level: number;
      if (firstCoeff && this.bits.read(1) === 1) {
        run = 0;
        level = this.bits.read(1) ? -1 : 1;
        firstCoeff = false;
      } else {
        if (firstCoeff) this.bits.rewind(1); // peeked a '0'; let readHuffman consume it
        firstCoeff = false;
        const coeff = this.readHuffman(dctCoeffTable);
        // EOB is the leaf 0xFFFE in both B-14 ('10') and B-15 ('0110').
        if (coeff === 0xFFFE) break;
        if (coeff === 0xffff) {
          run = this.bits.read(6);
          if (isMPEG2) {
            level = this.bits.read(12);
            if (level >= 2048) level -= 4096;
          } else {
            level = this.bits.read(8);
            if (level === 0) level = this.bits.read(8);
            else if (level === 128) level = this.bits.read(8) - 256;
            else if (level > 128) level -= 256;
          }
        } else {
          run = coeff >> 8;
          level = coeff & 0xff;
          if (this.bits.read(1)) level = -level;
        }
      }
      n += run;
      if (n >= 64) break;
      const dezigZagged = zigZag[n];
      n++;
      level <<= 1;
      if (!isIntra) level += (level < 0 ? -1 : 1);
      // Dequant scale differs by codec: MPEG-1 divides by 16 ((2·QF[±1])·W·qs / 16),
      // MPEG-2 by 32 (ISO 13818-2 7.4.2.3). Using /16 for MPEG-2 makes every AC
      // coefficient twice the correct amplitude → ~2× ringing/overshoot at edges
      // while flat (DC-only) areas stay correct.
      level = (level * qs * quantMatrix[dezigZagged]) >> (isMPEG2 ? 5 : 4);
      if (isMPEG2) {
        if (level > 2047) level = 2047; else if (level < -2047) level = -2047;
        mismatchParity ^= (level & 1);
      } else {
        if ((level & 1) === 0) level -= level > 0 ? 1 : -1;
        if (level > 2047) level = 2047; else if (level < -2048) level = -2048;
      }
      this.blockData[dezigZagged] = level * PREMULTIPLIER_MATRIX[dezigZagged];
    }

    if (isMPEG2) {
      const dcParity = (isIntra && this.intraDcPrecision === 3) ? ((this.blockData[0] >> 5) & 1) : 0;
      if (((mismatchParity ^ dcParity) & 1) === 0) this.blockData[63] ^= 2;
    }

    let destArray: Uint8ClampedArray;
    let destIndex: number;
    let scan: number;

    // In a field-DCT macroblock the 8 rows of each block belong alternately to the
    // top and bottom field, so consecutive block rows land two raster lines apart.
    // Lower blocks (the bottom field) start one raster line below the top field.
    const fieldDct = this.dctType;
    if (block < 4) {
      destArray = this.currentY;
      const W = this.codedWidth;
      const mbBase = ((this.mbRow << 4) * W) + (this.mbCol << 4);
      if (fieldDct) {
        scan = (W << 1) - 8;
        destIndex = mbBase + ((block & 1) ? 8 : 0) + ((block & 2) ? W : 0);
      } else {
        scan = W - 8;
        destIndex = mbBase + ((block & 1) ? 8 : 0) + ((block & 2) ? (W << 3) : 0);
      }
    } else {
      const hw = this.halfWidth;
      destArray = ((block & 1) === 0) ? this.currentCb : this.currentCr;
      if (this.chromaFormat === 2) {
        // 4:2:2 chroma blocks stay frame-organized even in a field-DCT macroblock:
        // block 4/5 = top 8 lines, block 6/7 = bottom 8 lines.
        const cmbBase = ((this.mbRow << 4) * hw) + (this.mbCol << 3);
        scan = hw - 8;
        destIndex = cmbBase + ((block < 6) ? 0 : (hw << 3));
      } else {
        scan = hw - 8;
        destIndex = ((this.mbRow * this.codedWidth) << 2) + (this.mbCol << 3);
      }
    }

    if (this.macroblockIntra) {
      if (n === 1) {
        copyValue((this.blockData[0] + 128) >> 8, destArray, destIndex, scan);
        this.blockData[0] = 0;
      } else {
        idct(this.blockData);
        copyBlock(this.blockData, destArray, destIndex, scan);
        this.blockData.fill(0);
      }
    } else {
      if (n === 1) {
        addValue((this.blockData[0] + 128) >> 8, destArray, destIndex, scan);
        this.blockData[0] = 0;
      } else {
        idct(this.blockData);
        addBlock(this.blockData, destArray, destIndex, scan);
        this.blockData.fill(0);
      }
    }
    // n is reset implicitly — the loop variable; no explicit reset needed
  }
}

// ---------------------------------------------------------------------------
// IDCT + block copy helpers
// ---------------------------------------------------------------------------

function idct(block: Int32Array): void {
  let b1: number, b3: number, b4: number, b6: number, b7: number, tmp1: number, tmp2: number, m0: number;
  let x0: number, x1: number, x2: number, x3: number, x4: number, y3: number, y4: number, y5: number, y6: number, y7: number;

  for (let i = 0; i < 8; i++) {
    b1 = block[4*8+i]; b3 = block[2*8+i] + block[6*8+i]; b4 = block[5*8+i] - block[3*8+i];
    tmp1 = block[1*8+i] + block[7*8+i]; tmp2 = block[3*8+i] + block[5*8+i];
    b6 = block[1*8+i] - block[7*8+i]; b7 = tmp1 + tmp2;
    m0 = block[0*8+i];
    x4 = ((b6*473 - b4*196 + 128) >> 8) - b7;
    x0 = x4 - (((tmp1 - tmp2)*362 + 128) >> 8);
    x1 = m0 - b1; x2 = (((block[2*8+i] - block[6*8+i])*362 + 128) >> 8) - b3; x3 = m0 + b1;
    y3 = x1 + x2; y4 = x3 + b3; y5 = x1 - x2; y6 = x3 - b3;
    y7 = -x0 - ((b4*473 + b6*196 + 128) >> 8);
    block[0*8+i] = b7 + y4; block[1*8+i] = x4 + y3; block[2*8+i] = y5 - x0; block[3*8+i] = y6 - y7;
    block[4*8+i] = y6 + y7; block[5*8+i] = x0 + y5; block[6*8+i] = y3 - x4; block[7*8+i] = y4 - b7;
  }
  for (let i = 0; i < 64; i += 8) {
    b1 = block[4+i]; b3 = block[2+i] + block[6+i]; b4 = block[5+i] - block[3+i];
    tmp1 = block[1+i] + block[7+i]; tmp2 = block[3+i] + block[5+i];
    b6 = block[1+i] - block[7+i]; b7 = tmp1 + tmp2;
    m0 = block[0+i];
    x4 = ((b6*473 - b4*196 + 128) >> 8) - b7;
    x0 = x4 - (((tmp1 - tmp2)*362 + 128) >> 8);
    x1 = m0 - b1; x2 = (((block[2+i] - block[6+i])*362 + 128) >> 8) - b3; x3 = m0 + b1;
    y3 = x1 + x2; y4 = x3 + b3; y5 = x1 - x2; y6 = x3 - b3;
    y7 = -x0 - ((b4*473 + b6*196 + 128) >> 8);
    block[0+i] = (b7 + y4 + 128) >> 8; block[1+i] = (x4 + y3 + 128) >> 8;
    block[2+i] = (y5 - x0 + 128) >> 8; block[3+i] = (y6 - y7 + 128) >> 8;
    block[4+i] = (y6 + y7 + 128) >> 8; block[5+i] = (x0 + y5 + 128) >> 8;
    block[6+i] = (y3 - x4 + 128) >> 8; block[7+i] = (y4 - b7 + 128) >> 8;
  }
}

function copyBlock(block: Int32Array, dest: Uint8ClampedArray, index: number, scan: number): void {
  for (let n = 0; n < 64; n += 8, index += scan + 8) {
    dest[index]   = block[n];   dest[index+1] = block[n+1]; dest[index+2] = block[n+2]; dest[index+3] = block[n+3];
    dest[index+4] = block[n+4]; dest[index+5] = block[n+5]; dest[index+6] = block[n+6]; dest[index+7] = block[n+7];
  }
}

function addBlock(block: Int32Array, dest: Uint8ClampedArray, index: number, scan: number): void {
  for (let n = 0; n < 64; n += 8, index += scan + 8) {
    dest[index]   += block[n];   dest[index+1] += block[n+1]; dest[index+2] += block[n+2]; dest[index+3] += block[n+3];
    dest[index+4] += block[n+4]; dest[index+5] += block[n+5]; dest[index+6] += block[n+6]; dest[index+7] += block[n+7];
  }
}

function copyValue(value: number, dest: Uint8ClampedArray, index: number, scan: number): void {
  for (let n = 0; n < 64; n += 8, index += scan + 8) {
    dest[index] = dest[index+1] = dest[index+2] = dest[index+3] = value;
    dest[index+4] = dest[index+5] = dest[index+6] = dest[index+7] = value;
  }
}

function addValue(value: number, dest: Uint8ClampedArray, index: number, scan: number): void {
  for (let n = 0; n < 64; n += 8, index += scan + 8) {
    dest[index] += value; dest[index+1] += value; dest[index+2] += value; dest[index+3] += value;
    dest[index+4] += value; dest[index+5] += value; dest[index+6] += value; dest[index+7] += value;
  }
}
