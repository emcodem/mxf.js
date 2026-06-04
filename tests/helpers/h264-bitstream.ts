/**
 * Test-only H.264 bitstream construction: an MSB-first bit writer plus minimal SPS / PPS / slice
 * NAL builders, enough to exercise the POC parsers and the reorder resolver without real essence.
 * The builders emit exactly the syntax the parsers read (they stop at the POC fields), so the
 * payloads are deliberately short and avoid 00 00 03 sequences (no emulation-prevention needed).
 */

export class BitWriter {
  private bits: number[] = [];

  u1(b: number): void { this.bits.push(b & 1); }
  u(n: number, val: number): void { for (let i = n - 1; i >= 0; i--) this.u1((val >> i) & 1); }
  ue(val: number): void {
    const code = val + 1;
    const len = Math.floor(Math.log2(code));
    for (let i = 0; i < len; i++) this.u1(0);
    for (let i = len; i >= 0; i--) this.u1((code >> i) & 1);
  }
  se(val: number): void { this.ue(val <= 0 ? -2 * val : 2 * val - 1); }

  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8) || 1);
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 1 << (7 - (i & 7)); });
    return out;
  }
}

export interface SpsFields {
  profileIdc?: number;
  log2MaxFrameNum?: number;        // actual value (>= 4)
  picOrderCntType?: number;
  log2MaxPicOrderCntLsb?: number;  // actual value (>= 4), type 0
  frameMbsOnly?: boolean;
  /** chroma_format_idc for high profiles (1=4:2:0, 2=4:2:2). Default 1. */
  chromaFormatIdc?: number;
  /** pic_width_in_mbs_minus1 (default 119 → 1920). */
  picWidthInMbsMinus1?: number;
  /** pic_height_in_map_units_minus1 (default 67). For frame_mbs_only=0, coded height = 2·(v+1)·16. */
  picHeightInMapUnitsMinus1?: number;
  /** When any crop offset is set, the SPS emits the post-frame_mbs_only fields + frame_cropping. */
  cropLeft?: number;
  cropRight?: number;
  cropTop?: number;
  cropBottom?: number;
}

/** Build an SPS NAL (header byte 0x67) carrying the given POC-relevant fields. */
export function buildSps(f: SpsFields = {}): Uint8Array {
  const profileIdc = f.profileIdc ?? 100;
  const log2MaxFrameNum = f.log2MaxFrameNum ?? 4;
  const picOrderCntType = f.picOrderCntType ?? 0;
  const log2MaxLsb = f.log2MaxPicOrderCntLsb ?? 6;
  const frameMbsOnly = f.frameMbsOnly ?? true;

  const w = new BitWriter();
  w.u(8, profileIdc);
  w.u(8, 0);            // constraint flags
  w.u(8, 42);           // level_idc
  w.ue(0);              // seq_parameter_set_id
  const isHigh = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc);
  if (isHigh) {
    w.ue(f.chromaFormatIdc ?? 1); // chroma_format_idc (default 1 = 4:2:0)
    w.ue(0);            // bit_depth_luma_minus8
    w.ue(0);            // bit_depth_chroma_minus8
    w.u1(0);            // qpprime_y_zero_transform_bypass_flag
    w.u1(0);            // seq_scaling_matrix_present_flag
  }
  w.ue(log2MaxFrameNum - 4);
  w.ue(picOrderCntType);
  if (picOrderCntType === 0) {
    w.ue(log2MaxLsb - 4);
  } else if (picOrderCntType === 1) {
    w.u1(0);            // delta_pic_order_always_zero_flag
    w.se(0);            // offset_for_non_ref_pic
    w.se(0);            // offset_for_top_to_bottom_field
    w.ue(0);            // num_ref_frames_in_pic_order_cnt_cycle
  }
  w.ue(2);              // max_num_ref_frames
  w.u1(0);              // gaps_in_frame_num_value_allowed_flag
  w.ue(f.picWidthInMbsMinus1 ?? 119);            // pic_width_in_mbs_minus1  (default 1920)
  w.ue(f.picHeightInMapUnitsMinus1 ?? 67);       // pic_height_in_map_units_minus1
  w.u1(frameMbsOnly ? 1 : 0);
  // POC parsing stops here; the display-dimension parse continues through frame_cropping. Emit those
  // fields only when a crop is requested (keeps existing fixtures byte-identical via zero-extension).
  const cropL = f.cropLeft ?? 0, cropR = f.cropRight ?? 0, cropT = f.cropTop ?? 0, cropB = f.cropBottom ?? 0;
  if (cropL || cropR || cropT || cropB) {
    if (!frameMbsOnly) w.u1(0); // mb_adaptive_frame_field_flag
    w.u1(0);                    // direct_8x8_inference_flag
    w.u1(1);                    // frame_cropping_flag
    w.ue(cropL); w.ue(cropR); w.ue(cropT); w.ue(cropB);
  }
  const payload = w.bytes();
  const out = new Uint8Array(payload.length + 1);
  out[0] = 0x67;        // nal_ref_idc=3, type=7 (SPS)
  out.set(payload, 1);
  return out;
}

/** Build a PPS NAL (header byte 0x68) with the given bottom-field POC flag. */
export function buildPps(bottomFieldPicOrderPresent = false): Uint8Array {
  const w = new BitWriter();
  w.ue(0);  // pic_parameter_set_id
  w.ue(0);  // seq_parameter_set_id
  w.u1(0);  // entropy_coding_mode_flag
  w.u1(bottomFieldPicOrderPresent ? 1 : 0);
  const payload = w.bytes();
  const out = new Uint8Array(payload.length + 1);
  out[0] = 0x68;        // type=8 (PPS)
  out.set(payload, 1);
  return out;
}

export interface SliceSpec {
  /** 0=P, 1=B, 2=I. */
  sliceType: number;
  /** true → IDR slice (nal_unit_type 5). */
  idr?: boolean;
  /** nal_ref_idc (0 = non-reference). Defaults: IDR/I/P → 3/2, B → 0. */
  refIdc?: number;
  frameNum: number;
  picOrderCntLsb: number;
  log2MaxFrameNum?: number;
  log2MaxPicOrderCntLsb?: number;
}

/** Build a coded-slice NAL carrying just the header through the POC fields. */
export function buildSliceNal(s: SliceSpec): Uint8Array {
  const log2MaxFrameNum = s.log2MaxFrameNum ?? 4;
  const log2MaxLsb = s.log2MaxPicOrderCntLsb ?? 6;
  const idr = !!s.idr;
  const refIdc = s.refIdc ?? (s.sliceType === 1 ? 0 : (idr ? 3 : 2));
  const type = idr ? 5 : 1;

  const w = new BitWriter();
  w.ue(0);                  // first_mb_in_slice
  w.ue(s.sliceType);        // slice_type
  w.ue(0);                  // pic_parameter_set_id
  w.u(log2MaxFrameNum, s.frameNum);
  if (idr) w.ue(0);         // idr_pic_id
  w.u(log2MaxLsb, s.picOrderCntLsb);
  // (parser stops here; bottom-field delta absent)
  const payload = w.bytes();
  const out = new Uint8Array(payload.length + 1);
  out[0] = ((refIdc & 3) << 5) | (type & 0x1f);
  out.set(payload, 1);
  return out;
}

/** Concatenate NALUs into a 4-byte-length-prefixed AVCC access unit. */
export function toAvcc(nals: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const n of nals) total += 4 + n.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  for (const n of nals) {
    dv.setUint32(off, n.length, false);
    off += 4;
    out.set(n, off);
    off += n.length;
  }
  return out;
}
