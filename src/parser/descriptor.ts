import { DataViewReader } from '../core/data-view-reader.js';

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

// Known picture essence coding ULs (bytes 8-15 identify codec)
// H.264 / AVC: 06 0E 2B 34 04 01 01 0A 04 01 02 02 01 32 ...
const AVC_CODING_PREFIX = new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x0a,0x04,0x01,0x02,0x02,0x01,0x32]);
// MPEG-2: 06 0E 2B 34 04 01 01 03 04 01 02 02 01 ...
const MPEG2_CODING_PREFIX = new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x03,0x04,0x01,0x02,0x02,0x01]);
// MPEG-2 variant 2: 06 0E 2B 34 04 01 01 01 04 01 02 02 01 ...
const MPEG2_CODING_PREFIX2 = new Uint8Array([0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x01,0x04,0x01,0x02,0x02,0x01]);

function ulStartsWith(ul: Uint8Array, prefix: Uint8Array): boolean {
  if (ul.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (ul[i] !== prefix[i]) return false;
  return true;
}

function identifyVideoCodec(codingUL: Uint8Array): VideoCodec {
  if (ulStartsWith(codingUL, AVC_CODING_PREFIX)) return 'h264';
  if (ulStartsWith(codingUL, MPEG2_CODING_PREFIX)) return 'mpeg2';
  if (ulStartsWith(codingUL, MPEG2_CODING_PREFIX2)) return 'mpeg2';
  return 'unknown';
}

// Local tag constants (standard MXF local tags used without Primer lookup for well-known values)
const TAG_STORED_WIDTH         = 0x3203;
const TAG_STORED_HEIGHT        = 0x3202;
const TAG_SAMPLE_RATE          = 0x3001;
const TAG_PICTURE_ESSENCE_CODING = 0x3201;
const TAG_AUDIO_SAMPLING_RATE  = 0x3D03;
const TAG_CHANNEL_COUNT        = 0x3D07;
const TAG_QUANTIZATION_BITS    = 0x3D01;
const TAG_BLOCK_ALIGN          = 0x3D0A; // 0x3D09 is AvgBytesPerSecond, not BlockAlign

interface LocalSet {
  tag: number;
  data: Uint8Array;
}

function parseLocalSets(buffer: ArrayBuffer, valueOffset: number, valueLength: number): LocalSet[] {
  const r = new DataViewReader(buffer, valueOffset);
  const end = valueOffset + valueLength;
  const sets: LocalSet[] = [];
  while (r.offset < end - 3) {
    const tag = r.readU16BE();
    const len = r.readU16BE();
    if (r.offset + len > end) break;
    sets.push({ tag, data: r.readBytesCopy(len) });
  }
  return sets;
}

export function parsePictureDescriptor(
  buffer: ArrayBuffer,
  valueOffset: number,
  valueLength: number
): PictureDescriptor {
  const sets = parseLocalSets(buffer, valueOffset, valueLength);
  let codec: VideoCodec = 'unknown';
  let storedWidth = 0;
  let storedHeight = 0;
  let frameRateNumerator = 25;
  let frameRateDenominator = 1;
  let pictureEssenceCodingUL: Uint8Array | null = null;

  for (const { tag, data } of sets) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (tag) {
      case TAG_STORED_WIDTH:
        storedWidth = v.getUint32(0, false);
        break;
      case TAG_STORED_HEIGHT:
        storedHeight = v.getUint32(0, false);
        break;
      case TAG_SAMPLE_RATE:
        frameRateNumerator = v.getInt32(0, false);
        frameRateDenominator = v.getInt32(4, false);
        break;
      case TAG_PICTURE_ESSENCE_CODING:
        if (data.length >= 16) {
          pictureEssenceCodingUL = data.slice(0, 16);
          codec = identifyVideoCodec(pictureEssenceCodingUL);
        }
        break;
    }
  }

  return {
    codec,
    width: storedWidth,
    height: storedHeight,
    storedWidth,
    storedHeight,
    frameRateNumerator,
    frameRateDenominator,
    spsNALU: null,
    ppsNALU: null,
    pictureEssenceCodingUL,
  };
}

export function parseSoundDescriptor(
  buffer: ArrayBuffer,
  valueOffset: number,
  valueLength: number
): SoundDescriptor {
  const sets = parseLocalSets(buffer, valueOffset, valueLength);
  let codec: AudioCodec = 'pcm';
  let sampleRate = 48000;
  let channelCount = 2;
  let bitDepth = 16;
  let blockAlign = 0;

  for (const { tag, data } of sets) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (tag) {
      case TAG_AUDIO_SAMPLING_RATE:
        sampleRate = v.getInt32(0, false);
        break;
      case TAG_CHANNEL_COUNT:
        channelCount = v.getUint32(0, false);
        break;
      case TAG_QUANTIZATION_BITS:
        bitDepth = v.getUint32(0, false);
        break;
      case TAG_BLOCK_ALIGN:
        blockAlign = v.getUint32(0, false);
        break;
    }
  }

  if (blockAlign === 0) {
    blockAlign = channelCount * (bitDepth / 8);
  }

  return { codec, sampleRate, channelCount, bitDepth, blockAlign };
}
