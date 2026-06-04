import { ulStartsWith } from '../core/ul.js';

export type VideoCodec = 'h264' | 'mpeg2' | 'unknown';
export type AudioCodec = 'pcm' | 'aac' | 'unknown';

export interface PictureDescriptor {
  codec: VideoCodec;
  width: number;
  height: number;
  storedWidth: number;
  storedHeight: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  /**
   * Display Aspect Ratio (DAR) from the MXF AspectRatio item (tag 0x320E), e.g. 16/9. This is how
   * the active picture should be SHOWN, independent of the pixel grid — 4:3-stored anamorphic SD
   * (720×576/608) and XDCAM-EX (1440×1080) carry 16:9 here. 0/0 when absent (→ display square, 1:1).
   */
  aspectRatioNum: number;
  aspectRatioDen: number;
  /** SPS NALU (without start code), if found in descriptor */
  spsNALU: Uint8Array | null;
  /** PPS NALU (without start code), if found in descriptor */
  ppsNALU: Uint8Array | null;
  /** Raw picture essence coding UL */
  pictureEssenceCodingUL: Uint8Array | null;
}

export interface SoundDescriptor {
  codec: AudioCodec;
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  blockAlign: number;
}

// ── Picture essence coding UL → codec identification (single shared table) ───
// Bytes 8-15 of the PictureEssenceCoding UL identify the codec; byte 7 (the SMPTE
// item designator) varies between registrations, so each codec lists its known
// prefix variants. This is the only codec-identification table in the codebase —
// metadata.ts imports identifyVideoCodec rather than re-deriving it.
const AVC_CODING_PREFIXES: Uint8Array[] = [
  // AVC / H.264: …01 0a 04 01 02 02 01 32 and the …01 09… designator variant
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x0a,0x04,0x01,0x02,0x02,0x01,0x32]),
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x09,0x04,0x01,0x02,0x02,0x01,0x32]),
  // AVC byte-13 = 0x31 variant used by Long-GOP XAVC-L (e.g. …01 31 40 01); the trailing two bytes
  // carry the profile/level, so match only through the …02 01 31 family prefix. Confirmed H.264 by
  // parsing SPS/PPS/POC + B-slices from the essence of xavc_l_1080p50.mxf.
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x0a,0x04,0x01,0x02,0x02,0x01,0x31]),
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x09,0x04,0x01,0x02,0x02,0x01,0x31]),
];
const MPEG2_CODING_PREFIXES: Uint8Array[] = [
  // MPEG-2: …01 03 04 01 02 02 01 and the …01 01… designator variant
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x03,0x04,0x01,0x02,0x02,0x01]),
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x01,0x04,0x01,0x02,0x02,0x01]),
];

export function identifyVideoCodec(codingUL: Uint8Array): VideoCodec {
  if (AVC_CODING_PREFIXES.some(p => ulStartsWith(codingUL, p))) return 'h264';
  if (MPEG2_CODING_PREFIXES.some(p => ulStartsWith(codingUL, p))) return 'mpeg2';
  return 'unknown';
}
