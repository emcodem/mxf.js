import { parseSpsPocInfo } from './h264-poc.js';

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

/** Check if buffer starts with Annex B start code */
export function isAnnexB(buffer: ArrayBuffer): boolean {
  const u8 = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return (u8[0] === 0 && u8[1] === 0 && u8[2] === 0 && u8[3] === 1) ||
         (u8[0] === 0 && u8[1] === 0 && u8[2] === 1);
}
