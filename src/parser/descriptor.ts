import { ulMatchEssenceCodingPrefix } from '../core/ul.js';

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
// Byte 7 of a PictureEssenceCoding UL is the SMPTE item-designator / registry-version
// and varies across spec revisions (0x01, 0x03, 0x09, 0x0a, 0x0d, …). All entries
// below use 0x7f as a placeholder at position 7; ulMatchEssenceCodingPrefix skips it.
const AVC_CODING_PREFIXES: Uint8Array[] = [
  // byte-13 = 0x32: AVC-Intra
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x7f,0x04,0x01,0x02,0x02,0x01,0x32]),
  // byte-13 = 0x31: Long-GOP / XAVC-L (trailing bytes carry profile/level, so match through 0x31 only)
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x7f,0x04,0x01,0x02,0x02,0x01,0x31]),
  // byte-13 = 0x30: H.264/MPEG-4 AVC Video (SMPTE generic AVC label)
  new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x7f,0x04,0x01,0x02,0x02,0x01,0x30]),
];
// MPEG-2: byte-13 = 0x00–0x09.  byte-13 = 0x10 is MPEG-1 (not supported → 'unknown').
const MPEG2_BASE_PREFIX = new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x7f,0x04,0x01,0x02,0x02,0x01]);

export function identifyVideoCodec(codingUL: Uint8Array): VideoCodec {
  if (AVC_CODING_PREFIXES.some(p => ulMatchEssenceCodingPrefix(codingUL, p))) return 'h264';
  if (ulMatchEssenceCodingPrefix(codingUL, MPEG2_BASE_PREFIX) && codingUL[13] <= 0x09) return 'mpeg2';
  return 'unknown';
}
