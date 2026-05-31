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

/** Build avcC decoder configuration record from SPS and PPS NALUs */
export function buildAVCDecoderConfigRecord(spsNALU: Uint8Array, ppsNALU: Uint8Array): Uint8Array {
  const spsLen = spsNALU.length;
  const ppsLen = ppsNALU.length;
  const out = new Uint8Array(11 + spsLen + ppsLen);
  const v = new DataView(out.buffer);
  let i = 0;

  out[i++] = 1;                   // configurationVersion
  out[i++] = spsNALU[1];          // AVCProfileIndication
  out[i++] = spsNALU[2];          // profile_compatibility
  out[i++] = spsNALU[3];          // AVCLevelIndication
  out[i++] = 0xff;                 // lengthSizeMinusOne = 3 → 4-byte NALU lengths
  out[i++] = 0xe1;                 // numSequenceParameterSets = 1
  v.setUint16(i, spsLen, false); i += 2;
  out.set(spsNALU, i); i += spsLen;
  out[i++] = 1;                    // numPictureParameterSets = 1
  v.setUint16(i, ppsLen, false); i += 2;
  out.set(ppsNALU, i);

  return out;
}

/**
 * Parse the coded (macroblock-aligned, pre-crop) luma dimensions from an SPS NALU.
 * Returns null if parsing fails. These are the dimensions Chrome's MSE stream parser derives from
 * the SPS, so the avc1/VisualSampleEntry box must declare the SAME values or the init segment is
 * rejected. In particular interlaced AVC-Intra (frame_mbs_only_flag = 0) codes the full frame
 * height (e.g. 1088) even though the MXF descriptor stores the per-field height (e.g. 544).
 */
export function parseSPSCodedDimensions(spsNALU: Uint8Array): { width: number; height: number } | null {
  try {
    // Strip the NAL header byte, then remove emulation-prevention bytes (00 00 03 → 00 00).
    const rbsp: number[] = [];
    for (let i = 1; i < spsNALU.length; i++) {
      if (i >= 3 && spsNALU[i] === 0x03 && spsNALU[i - 1] === 0x00 && spsNALU[i - 2] === 0x00 && rbsp.length >= 2 &&
          rbsp[rbsp.length - 1] === 0x00 && rbsp[rbsp.length - 2] === 0x00) {
        continue; // skip emulation-prevention byte
      }
      rbsp.push(spsNALU[i]);
    }

    let bitPos = 0;
    const u1 = (): number => {
      const byte = rbsp[bitPos >> 3];
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      bitPos++;
      return bit;
    };
    const u = (n: number): number => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | u1(); return v; };
    const ue = (): number => {
      let zeros = 0;
      while (u1() === 0 && zeros < 32) zeros++;
      let v = 0;
      for (let i = 0; i < zeros; i++) v = (v << 1) | u1();
      return v + (1 << zeros) - 1;
    };
    const se = (): number => { const k = ue(); return (k & 1) ? (k + 1) >> 1 : -(k >> 1); };

    const profileIdc = u(8);
    u(8);        // constraint flags + reserved
    u(8);        // level_idc
    ue();        // seq_parameter_set_id

    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      const chromaFormatIdc = ue();
      if (chromaFormatIdc === 3) u1(); // separate_colour_plane_flag
      ue();      // bit_depth_luma_minus8
      ue();      // bit_depth_chroma_minus8
      u1();      // qpprime_y_zero_transform_bypass_flag
      if (u1()) { // seq_scaling_matrix_present_flag
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (u1()) { // scaling list present
            let lastScale = 8, nextScale = 8;
            const size = i < 6 ? 16 : 64;
            for (let j = 0; j < size; j++) {
              if (nextScale !== 0) { const delta = se(); nextScale = (lastScale + delta + 256) % 256; }
              lastScale = nextScale === 0 ? lastScale : nextScale;
            }
          }
        }
      }
    }

    ue();        // log2_max_frame_num_minus4
    const picOrderCntType = ue();
    if (picOrderCntType === 0) {
      ue();      // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      u1();      // delta_pic_order_always_zero_flag
      se();      // offset_for_non_ref_pic
      se();      // offset_for_top_to_bottom_field
      const n = ue();
      for (let i = 0; i < n; i++) se();
    }

    ue();        // max_num_ref_frames
    u1();        // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = ue();
    const picHeightInMapUnitsMinus1 = ue();
    const frameMbsOnlyFlag = u1();

    const width = (picWidthInMbsMinus1 + 1) * 16;
    const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16;
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return null;
    return { width, height };
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
