import { MxfMetadata } from '../parser/metadata.js';
import { EssenceFrame } from '../essence/essence-extractor.js';
import { isAnnexB, annexBtoAVCC, extractSPSPPS, parseSPSCodedDimensions } from '../essence/avc-tools.js';
import {
  ftyp, moov, mvhd, trak, tkhd, mdia, vmhd, smhd, stbl, stsd,
  avc1, mp4v, mp4a, sowt, mvex, trex, moof, mdat, traf, TrunSample,
} from './mp4-boxes.js';

// Track IDs
export const VIDEO_TRACK_ID = 1;
export const AUDIO_TRACK_ID = 2;

// Sync sample flag for trun
const SAMPLE_FLAG_SYNC     = 0x00000000;
const SAMPLE_FLAG_NON_SYNC = 0x00010000;

export interface FragmenterConfig {
  videoTimescale: number;
  audioTimescale: number;
  /** Duration of one video frame in videoTimescale ticks */
  frameDurationTicks: number;
  /** Number of audio samples per video frame period */
  audioSamplesPerFrame: number;
}

export class Mp4Fragmenter {
  private readonly metadata: MxfMetadata;
  private config: FragmenterConfig | null = null;
  private spsNALUs: Uint8Array[] = [];
  private ppsNALUs: Uint8Array[] = [];
  private seqNum = 0;
  private videoCodec: 'h264' | 'mpeg2' | 'unknown' = 'unknown';
  private transcodeWidth = 0;
  private transcodeHeight = 0;

  constructor(metadata: MxfMetadata) {
    this.metadata = metadata;
  }

  buildInitSegment(includeAudio = true): Uint8Array {
    const pd = this.metadata.pictureDescriptor;
    const sd = this.metadata.soundDescriptor;

    // Always derive frameDurationTicks from the track edit rate, NOT the picture descriptor's
    // SampleRate (tag 0x3001). For interlaced content the descriptor often stores the field rate
    // (e.g. 50/1 for 1080i50) while the edit rate is the frame rate (25/1). The edit unit counter
    // increments once per coded AU (= per frame), so baseTime = editUnit * frameDurationTicks is
    // only correct when frameDurationTicks is computed from the edit rate. Using the field rate
    // halves every timestamp → video plays at 2× speed until a seek re-anchors currentTime.
    const frameRateNum = this.metadata.editRateNumerator;
    const frameRateDen = this.metadata.editRateDenominator;

    const videoTimescale = 90000; // standard 90 kHz
    const frameDurationTicks = Math.round(videoTimescale * frameRateDen / frameRateNum);
    const audioSampleRate = sd?.sampleRate ?? 48000;
    const durationTicks = Number(this.metadata.duration) * frameDurationTicks;

    this.config = {
      videoTimescale,
      audioTimescale: audioSampleRate,
      frameDurationTicks,
      audioSamplesPerFrame: Math.round(audioSampleRate * frameRateDen / frameRateNum),
    };

    // Only set videoCodec from descriptor if it hasn't been overridden by enableTranscodeMode.
    if (this.videoCodec === 'unknown') {
      this.videoCodec = pd?.codec ?? 'unknown';
    }

    const tracks: Uint8Array[] = [];

    if (pd) {
      // In transcode mode use dimensions from the MPEG-2 elementary stream (parsed by the
      // decoder from sequence headers) rather than the MXF descriptor, which may be wrong
      // (e.g. 1920×544 stored-height for a 1920×1080 programme) or missing entirely.
      let w = this.transcodeWidth || pd.storedWidth || pd.width;
      let h = this.transcodeHeight || pd.storedHeight || pd.height;

      // For native H.264, the avc1 box dimensions must match the coded size Chrome derives from
      // the SPS, or its MSE stream parser rejects the init segment. The MXF descriptor often
      // stores per-field height for interlaced AVC-Intra (e.g. 544 for a 1088-line MBAFF frame),
      // so prefer the SPS-derived coded dimensions when available.
      if (this.videoCodec === 'h264' && this.spsNALUs.length > 0 && !this.transcodeWidth) {
        const dims = parseSPSCodedDimensions(this.spsNALUs[0]);
        if (dims) { w = dims.width; h = dims.height; }
      }

      let codecBox: Uint8Array;
      if (this.videoCodec === 'h264') {
        if (this.spsNALUs.length === 0 || this.ppsNALUs.length === 0) {
          // No SPS/PPS means we cannot build a correct avc1/avcC box. This used to silently emit a
          // hardcoded 1920×1080 High@4.0 SPS, which produced a WRONG-SIZED init segment for any
          // other resolution/profile — Chrome's MSE parser then rejected it (or, worse, mis-sized
          // the video). Fail loudly instead: the worker should have extracted SPS/PPS from the
          // first keyframe; surface that it couldn't rather than guessing.
          throw new Error('Cannot build H.264 init segment: SPS/PPS unavailable (extraction from the first keyframe failed)');
        }
        codecBox = avc1(w, h, this.spsNALUs, this.ppsNALUs);
      } else {
        codecBox = mp4v(w, h);
      }

      const videoStbl = stbl(stsd(codecBox));
      const videomdia = mdia(videoTimescale, durationTicks, 'vide', vmhd(), videoStbl);
      const videoTkhd = tkhd(VIDEO_TRACK_ID, durationTicks, w, h, true);
      tracks.push(trak(videoTkhd, videomdia));
    }

    if (includeAudio && sd && sd.codec !== 'unknown') {
      const audioTimescale = sd.sampleRate;
      const audioDurationTicks = Number(this.metadata.duration) * this.config.audioSamplesPerFrame;
      let audioCodecBox: Uint8Array;

      if (sd.codec === 'aac') {
        // Minimal AAC config: AAC-LC, sampleRate index, channelCount
        const srIndex = getSampleRateIndex(sd.sampleRate);
        const aacConfig = new Uint8Array([
          (0x02 << 3) | (srIndex >> 1),
          ((srIndex & 1) << 7) | (sd.channelCount << 3),
        ]);
        audioCodecBox = mp4a(sd.sampleRate, sd.channelCount, aacConfig);
      } else {
        audioCodecBox = sowt(sd.sampleRate, sd.channelCount, sd.bitDepth);
      }

      const audioStbl = stbl(stsd(audioCodecBox));
      const audiomdia = mdia(audioTimescale, audioDurationTicks, 'soun', smhd(), audioStbl);
      const audioTkhd = tkhd(AUDIO_TRACK_ID, audioDurationTicks, 0, 0, false);
      tracks.push(trak(audioTkhd, audiomdia));
    }

    const trexBoxes = tracks.map((_, i) => trex(i + 1));

    const moovBox = moov(
      mvhd(durationTicks, videoTimescale),
      ...tracks,
      mvex(...trexBoxes),
    );

    return concat(ftyp(), moovBox);
  }

  buildVideoSegment(frames: EssenceFrame[]): Uint8Array | null {
    if (!this.config || frames.length === 0) return null;

    const videoFrames = frames.filter(f => f.trackType === 'video');
    if (videoFrames.length === 0) return null;

    if (this.videoCodec === 'mpeg2') {
      // MPEG-2 is not directly supported in browser MSE; still package it but caller should warn
      return this.buildRawVideoSegment(videoFrames, 'mpeg2');
    }

    return this.buildRawVideoSegment(videoFrames, 'h264');
  }

  private buildRawVideoSegment(frames: EssenceFrame[], _codec: string): Uint8Array {
    const config = this.config!;
    const samples: TrunSample[] = [];
    const dataParts: Uint8Array[] = [];

    for (const frame of frames) {
      let data: ArrayBuffer;
      if (_codec === 'h264') {
        data = isAnnexB(frame.data) ? annexBtoAVCC(frame.data) : frame.data;

        // Extract SPS/PPS from first keyframe if not yet found (keep ALL PPS — slices may reference
        // a non-first one).
        if (this.spsNALUs.length === 0 && frame.isKeyframe) {
          const { sps, pps } = extractSPSPPS(data);
          if (sps.length > 0 && pps.length > 0) {
            this.spsNALUs = sps;
            this.ppsNALUs = pps;
          }
        }
      } else {
        data = frame.data;
      }

      const payload = new Uint8Array(data);
      dataParts.push(payload);
      samples.push({
        duration: config.frameDurationTicks,
        size: payload.length,
        flags: frame.isKeyframe ? SAMPLE_FLAG_SYNC : SAMPLE_FLAG_NON_SYNC,
        compositionTimeOffset: Number(frame.pts - frame.dts) * config.frameDurationTicks,
      });
    }

    const allData = concatU8(dataParts);
    const baseTime = frames[0].dts * BigInt(config.frameDurationTicks);

    // moof = 8 + mfhd(16) + traf(8 + tfhd(16) + tfdt_v1(20) + trun_v1(20 + N*16))
    //      = 88 + N*16
    const moofSize = 88 + samples.length * 16;
    const dataOffset = moofSize + 8; // 8 = mdat box header

    const trafBox = traf(VIDEO_TRACK_ID, baseTime, samples, dataOffset);
    const moofBox = moof(++this.seqNum, trafBox);
    const mdatBox = mdat(allData);
    return concat(moofBox, mdatBox);
  }

  buildAudioSegment(frames: EssenceFrame[]): Uint8Array | null {
    if (!this.config || frames.length === 0) return null;

    const audioFrames = frames.filter(f => f.trackType === 'audio');
    if (audioFrames.length === 0) return null;

    const config = this.config;
    const sd = this.metadata.soundDescriptor;
    const samplesPerFrame = config.audioSamplesPerFrame;

    const samples: TrunSample[] = [];
    const dataParts: Uint8Array[] = [];

    for (const frame of audioFrames) {
      const payload = new Uint8Array(frame.data);
      const actualSamples = sd ? Math.floor(payload.length / sd.blockAlign) : samplesPerFrame;
      dataParts.push(payload);
      samples.push({
        duration: actualSamples,
        size: payload.length,
        flags: SAMPLE_FLAG_SYNC,
        compositionTimeOffset: 0,
      });
    }

    const allData = concatU8(dataParts);
    const baseTime = frames[0].dts * BigInt(config.audioSamplesPerFrame);

    const moofSize = 88 + samples.length * 16;
    const dataOffset = moofSize + 8;

    const trafBox = traf(AUDIO_TRACK_ID, baseTime, samples, dataOffset);
    const moofBox = moof(++this.seqNum, trafBox);
    const mdatBox = mdat(allData);
    return concat(moofBox, mdatBox);
  }

  setSPSPPS(sps: Uint8Array[], pps: Uint8Array[]): void {
    this.spsNALUs = sps;
    this.ppsNALUs = pps;
  }

  /** Switch to H.264 transcode mode: overrides codec and sets display dimensions from the
   *  MPEG-2 elementary stream (more reliable than the MXF descriptor stored dimensions). The
   *  transcoder emits a single SPS/PPS pair. */
  enableTranscodeMode(sps: Uint8Array, pps: Uint8Array, width = 0, height = 0): void {
    this.videoCodec = 'h264';
    this.spsNALUs = [sps];
    this.ppsNALUs = [pps];
    this.transcodeWidth = width;
    this.transcodeHeight = height;
  }

  /**
   * Build a video segment from pre-encoded H.264 AVCC chunks (transcode path).
   * Each chunk: { data: ArrayBuffer (AVCC), isKeyframe: boolean, editUnit: bigint }
   */
  buildTranscodedVideoSegment(
    chunks: Array<{ data: ArrayBuffer; isKeyframe: boolean; editUnit: bigint }>,
    opts?: {
      /** Make the whole segment occupy this many frame periods on the timeline by extending the
       *  final sample's duration (used for I-frame-only previews so a single keyframe covers its
       *  whole GOP). Ignored if it would not lengthen the last sample. */
      totalDurationFrames?: number;
    },
  ): Uint8Array | null {
    if (!this.config || chunks.length === 0) return null;
    const config = this.config;
    const samples: TrunSample[] = [];
    const dataParts: Uint8Array[] = [];

    for (const chunk of chunks) {
      const payload = new Uint8Array(chunk.data);
      dataParts.push(payload);
      samples.push({
        duration: config.frameDurationTicks,
        size: payload.length,
        flags: chunk.isKeyframe ? SAMPLE_FLAG_SYNC : SAMPLE_FLAG_NON_SYNC,
        compositionTimeOffset: 0,
      });
    }

    // Stretch the final sample so the segment spans `totalDurationFrames` frame periods. With a
    // single-keyframe preview this makes that I-frame the displayed picture for its entire GOP.
    if (opts?.totalDurationFrames && opts.totalDurationFrames > samples.length) {
      const extraFrames = opts.totalDurationFrames - samples.length;
      samples[samples.length - 1].duration += extraFrames * config.frameDurationTicks;
    }

    const baseTime = chunks[0].editUnit * BigInt(config.frameDurationTicks);
    const moofSize = 88 + samples.length * 16;
    const dataOffset = moofSize + 8;
    const trafBox = traf(VIDEO_TRACK_ID, baseTime, samples, dataOffset);
    const moofBox = moof(++this.seqNum, trafBox);

    // Assemble moof + mdat into a single allocation, writing each chunk payload once. This avoids the
    // concatU8(dataParts) copy plus the mdat()/concat() copy the previous code paid (the whole H.264
    // payload was copied twice per segment). The mdat header matches box('mdat', …): u32 size + 'mdat'.
    let payloadLen = 0;
    for (const p of dataParts) payloadLen += p.length;
    const mdatSize = 8 + payloadLen;
    const out = new Uint8Array(moofBox.length + mdatSize);
    let o = 0;
    out.set(moofBox, o); o += moofBox.length;
    new DataView(out.buffer).setUint32(o, mdatSize, false); o += 4;
    out[o++] = 0x6d; out[o++] = 0x64; out[o++] = 0x61; out[o++] = 0x74; // 'mdat'
    for (const p of dataParts) { out.set(p, o); o += p.length; }
    return out;
  }

  get hasSPSPPS(): boolean { return this.spsNALUs.length > 0 && this.ppsNALUs.length > 0; }
  get spsPPS(): { sps: Uint8Array[]; pps: Uint8Array[] } | null {
    if (this.spsNALUs.length === 0 || this.ppsNALUs.length === 0) return null;
    return { sps: this.spsNALUs, pps: this.ppsNALUs };
  }
}

function getSampleRateIndex(sampleRate: number): number {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = rates.indexOf(sampleRate);
  return idx >= 0 ? idx : 3; // default to 48000
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function concatU8(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
