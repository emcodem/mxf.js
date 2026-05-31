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
