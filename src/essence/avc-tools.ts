import { parseSpsPocInfo, HIGH_PROFILES } from './h264-poc.js';
import { BitReader, BitWriter, stripEmulationPrevention } from './bitreader.js';

/** Convert H.264 Annex B byte stream (start codes) to AVCC length-prefixed format */
export function annexBtoAVCC(buffer: ArrayBuffer): ArrayBuffer {
  const src = new Uint8Array(buffer);
  const nalus: Uint8Array[] = [];
  let i = 0;

  while (i < src.length) {
    // Find start code: 0x000001 or 0x00000001
    if (i + 3 < src.length && src[i] === 0 && src[i+1] === 0 && src[i+2] === 0 && src[i+3] === 1) {
      i += 4;
    } else if (i + 2 < src.length && src[i] === 0 && src[i+1] === 0 && src[i+2] === 1) {
      i += 3;
    } else {
      i++;
      continue;
    }

    const start = i;
    // Find next start code
    let end = src.length;
    for (let j = start; j < src.length - 2; j++) {
      if (src[j] === 0 && src[j+1] === 0 && (src[j+2] === 1 || (j+3 < src.length && src[j+2] === 0 && src[j+3] === 1))) {
        end = j;
        break;
      }
    }
    if (end > start) {
      nalus.push(src.slice(start, end));
    }
    i = end;
  }

  // Calculate total size
  let totalSize = 0;
  for (const nalu of nalus) totalSize += 4 + nalu.length;

  const out = new Uint8Array(totalSize);
  const outView = new DataView(out.buffer);
  let offset = 0;
  for (const nalu of nalus) {
    outView.setUint32(offset, nalu.length, false);
    offset += 4;
    out.set(nalu, offset);
    offset += nalu.length;
  }
  return out.buffer;
}

export interface SPSPPSResult {
  sps: Uint8Array[];
  pps: Uint8Array[];
}

/** Extract SPS and PPS NALUs from AVCC-format data (or raw NALUs) */
export function extractSPSPPS(buffer: ArrayBuffer): SPSPPSResult {
  const src = new Uint8Array(buffer);
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  let i = 0;

  while (i + 4 < src.length) {
    const len = new DataView(src.buffer, src.byteOffset + i, 4).getUint32(0, false);
    i += 4;
    if (i + len > src.length) break;
    const nalu = src.slice(i, i + len);
    const nalType = nalu[0] & 0x1f;
    if (nalType === 7) sps.push(nalu);
    if (nalType === 8) pps.push(nalu);
    i += len;
  }
  return { sps, pps };
}

/**
 * Build an avcC decoder configuration record from one or more SPS and one or more PPS NALUs.
 * Including every PPS matters: a stream whose slices reference a second PPS fails to decode if the
 * config record only carries the first.
 */
export function buildAVCDecoderConfigRecord(spsList: Uint8Array[], ppsList: Uint8Array[]): Uint8Array {
  if (spsList.length === 0 || ppsList.length === 0) {
    throw new Error('buildAVCDecoderConfigRecord requires at least one SPS and one PPS');
  }
  const sps0 = spsList[0];
  const bytes: number[] = [
    1,                                  // configurationVersion
    sps0[1],                            // AVCProfileIndication
    sps0[2],                            // profile_compatibility
    sps0[3],                            // AVCLevelIndication
    0xff,                               // lengthSizeMinusOne = 3 → 4-byte NALU lengths
    0xe0 | (spsList.length & 0x1f),     // numSequenceParameterSets
  ];
  for (const sps of spsList) bytes.push((sps.length >> 8) & 0xff, sps.length & 0xff, ...sps);
  bytes.push(ppsList.length & 0xff);    // numPictureParameterSets
  for (const pps of ppsList) bytes.push((pps.length >> 8) & 0xff, pps.length & 0xff, ...pps);
  return new Uint8Array(bytes);
}

/**
 * Parse the coded (macroblock-aligned, pre-crop) luma dimensions from an SPS NALU.
 * Returns null if parsing fails. These are the dimensions Chrome's MSE stream parser derives from
 * the SPS, so the avc1/VisualSampleEntry box must declare the SAME values or the init segment is
 * rejected. In particular interlaced AVC-Intra (frame_mbs_only_flag = 0) codes the full frame
 * height (e.g. 1088) even though the MXF descriptor stores the per-field height (e.g. 544).
 */
export function parseSPSCodedDimensions(spsNALU: Uint8Array): { width: number; height: number } | null {
  const info = parseSpsPocInfo(spsNALU);
  if (!info) return null;
  const { codedWidth: width, codedHeight: height } = info;
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return null;
  return { width, height };
}

/** Re-insert H.264 emulation-prevention bytes into a raw RBSP (inverse of stripEmulationPrevention). */
function addEmulationPrevention(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i];
    if (zeros >= 2 && b <= 0x03) { out.push(0x03); zeros = 0; }
    out.push(b);
    zeros = b === 0x00 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** Skip an SPS scaling list (high-profile prologue only); mirrors h264-poc.ts. */
function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8, nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) nextScale = (lastScale + r.se() + 256) % 256;
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/**
 * Add (or replace) frame_cropping_rect in an SPS NALU so the coded (MB-aligned) frame is cropped to
 * the active display size. Chrome's WebCodecs VideoEncoder never emits frame_cropping_flag even when
 * displayHeight < codedHeight (e.g. 1080 vs the MB-padded 1088), so the decoder shows the padded
 * bottom rows (the MPEG-2 encoder fills them by edge-replicating the last line → a smeared bottom
 * macroblock row). Injecting the crop makes the SPS's natural size match the avc1/tkhd display dims,
 * and the player renders only the active picture.
 *
 * Returns the rewritten SPS NALU (with emulation-prevention re-applied), the original SPS unchanged
 * when no crop is needed, or null if the SPS could not be parsed (caller then keeps the original).
 * The chroma cropping unit assumes 4:2:0 (the transcoder always feeds I420), derived from the SPS.
 */
export function addSpsFrameCropping(
  sps: Uint8Array, codedWidth: number, codedHeight: number, displayWidth: number, displayHeight: number,
): Uint8Array | null {
  if (codedWidth === displayWidth && codedHeight === displayHeight) return sps;
  if (displayWidth > codedWidth || displayHeight > codedHeight) return null;
  try {
    const header = sps[0];
    const rbsp = stripEmulationPrevention(sps, true);
    const r = new BitReader(rbsp);

    const profileIdc = r.u(8); r.u(8); r.u(8); r.ue(); // constraints, level, seq_parameter_set_id
    let chromaFormatIdc = 1, separateColour = false;
    if (HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColour = r.u1() === 1;
      r.ue(); r.ue(); r.u1(); // bit_depth_luma/chroma, qpprime_y_zero_transform_bypass
      if (r.u1()) { // seq_scaling_matrix_present_flag
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) if (r.u1()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) { r.u1(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    r.ue(); r.u1(); r.ue(); r.ue(); // max_num_ref_frames, gaps_allowed, width/height in MBs
    const frameMbsOnly = r.u1() === 1;
    if (!frameMbsOnly) r.u1(); // mb_adaptive_frame_field_flag
    r.u1(); // direct_8x8_inference_flag
    const prefixEnd = r.bitPosition;          // just before frame_cropping_flag
    if (r.u1() === 1) { r.ue(); r.ue(); r.ue(); r.ue(); } // discard any existing crop
    const tailStart = r.bitPosition;          // just before vui_parameters_present_flag

    // rbsp_stop_one_bit is the last set bit; everything after it is zero padding. The VUI payload to
    // preserve is [tailStart, lastOne) — we re-emit the stop bit ourselves after the new fields.
    let lastOne = -1;
    for (let i = rbsp.length * 8 - 1; i >= 0; i--) {
      if ((rbsp[i >> 3] >> (7 - (i & 7))) & 1) { lastOne = i; break; }
    }
    if (lastOne < tailStart) lastOne = tailStart;

    const mono = chromaFormatIdc === 0 || separateColour;
    const cropUnitX = mono ? 1 : (chromaFormatIdc === 3 ? 1 : 2);
    const cropUnitY = (mono ? 1 : (chromaFormatIdc === 1 ? 2 : 1)) * (frameMbsOnly ? 1 : 2);
    const cropRight  = (codedWidth  - displayWidth)  / cropUnitX;
    const cropBottom = (codedHeight - displayHeight) / cropUnitY;
    if (!Number.isInteger(cropRight) || !Number.isInteger(cropBottom)) return null;

    const w = new BitWriter();
    w.copyBits(rbsp, 0, prefixEnd);
    w.u1(1);                                   // frame_cropping_flag
    w.ue(0); w.ue(cropRight); w.ue(0); w.ue(cropBottom); // left, right, top, bottom
    w.copyBits(rbsp, tailStart, lastOne - tailStart);    // vui_present_flag + VUI (no stop bit)
    w.u1(1);                                   // rbsp_stop_one_bit (toBytes zero-pads the rest)

    return new Uint8Array([header, ...addEmulationPrevention(w.toBytes())]);
  } catch {
    return null;
  }
}

/** Check if buffer starts with Annex B start code */
export function isAnnexB(buffer: ArrayBuffer): boolean {
  const u8 = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return (u8[0] === 0 && u8[1] === 0 && u8[2] === 0 && u8[3] === 1) ||
         (u8[0] === 0 && u8[1] === 0 && u8[2] === 1);
}
