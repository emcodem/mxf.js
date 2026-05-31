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

/** Check if buffer starts with Annex B start code */
export function isAnnexB(buffer: ArrayBuffer): boolean {
  const u8 = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return (u8[0] === 0 && u8[1] === 0 && u8[2] === 0 && u8[3] === 1) ||
         (u8[0] === 0 && u8[1] === 0 && u8[2] === 1);
}
