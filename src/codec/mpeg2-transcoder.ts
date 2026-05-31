import type { YUVFrame } from './mpeg2-decoder.js';

export interface TranscodedChunk {
  data: ArrayBuffer;   // H.264 AVCC format
  isKeyframe: boolean;
  editUnit: bigint;
  /** Presentation timestamp (microseconds) as supplied to encode(); the encoder preserves it. */
  timestampUs: number;
}

export interface SpsppsPair {
  sps: Uint8Array;
  pps: Uint8Array;
}

/**
 * Wraps WebCodecs VideoEncoder to transcode YUV frames (from Mpeg2Decoder) to H.264 AVCC.
 * VideoEncoder is available in dedicated workers (Chrome 94+).
 */
export class Mpeg2Transcoder {
  private encoder: VideoEncoder;
  private pendingChunks: TranscodedChunk[] = [];
  private _spspps: SpsppsPair | null = null;
  private _codecStr: string | null = null;
  private frameDurUs: number;
  private displayWidth: number;
  private displayHeight: number;
  private encoderError: Error | null = null;

  constructor(
    codedWidth: number,
    codedHeight: number,
    displayWidth: number,
    displayHeight: number,
    frameRate: number,
  ) {
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.frameDurUs = Math.round(1_000_000 / frameRate);

    // H.264 level is constrained by MaxFS (macroblocks per frame) AND MaxMBPS
    // (macroblocks per second). Pixel-rate alone is misleading for non-standard
    // resolutions like 1920×544 (4080 MBs/frame > Level 3.1's limit of 3600).
    const mbPerFrame = Math.ceil(codedWidth / 16) * Math.ceil(codedHeight / 16);
    const mbPerSec   = mbPerFrame * frameRate;
    let levelHex: string;
    if      (mbPerFrame <= 3600 && mbPerSec <= 108_000)  levelHex = '1f'; // Level 3.1: ≤1280×720
    else if (mbPerFrame <= 8192 && mbPerSec <= 245_760)  levelHex = '28'; // Level 4.0: ≤1920×1088
    else if (mbPerFrame <= 8704 && mbPerSec <= 522_240)  levelHex = '2a'; // Level 4.2
    else                                                  levelHex = '33'; // Level 5.1

    const targetBitrate = Math.min(50_000_000, Math.round(codedWidth * codedHeight * frameRate * 0.15));

    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        // Encoder output is already in AVCC format (no inline SPS/PPS).
        const avccBuf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(avccBuf);

        // On the first keyframe Chrome supplies the avcC (AVCDecoderConfigurationRecord)
        // in metadata.decoderConfig.description.  We parse SPS/PPS out of it directly
        // rather than extracting inline parameter-set NALUs from the bitstream.
        // This guarantees the avcC we put in the init segment is exactly the one the
        // browser's own decoder expects — eliminating the annexb→AVCC conversion and
        // avoiding any SPS mismatch that causes a SourceBuffer error.
        if (!this._spspps && chunk.type === 'key' && metadata?.decoderConfig?.description) {
          const desc = metadata.decoderConfig.description;
          const descBuf: ArrayBuffer =
            desc instanceof ArrayBuffer ? desc : (desc as ArrayBufferView).buffer as ArrayBuffer;
          const result = parseSPSPPSFromAvcC(descBuf);
          if (result.sps && result.pps) {
            // Chrome's VideoEncoder sets constraint_set4_flag and constraint_set5_flag
            // (bits 3 and 2 of SPS[2]) even for Main Profile, where they are invalid
            // (they mean "Progressive High" and "I-only stream" respectively).
            // Chrome's MSE stream parser rejects the init segment when it sees these
            // contradictory constraint bits. Sanitize: keep only constraint_set0 (bit 7)
            // and constraint_set1 (bit 6), which are valid for Baseline/Main Profile.
            const sps = result.sps.slice();
            sps[2] = sps[2] & 0xc0;
            this._spspps = { sps, pps: result.pps };
            this._codecStr = metadata.decoderConfig.codec ?? null;
          }
        }

        this.pendingChunks.push({
          data: avccBuf,
          isKeyframe: chunk.type === 'key',
          editUnit: 0n,
          timestampUs: chunk.timestamp,
        });
      },
      error: (e) => { this.encoderError = e; },
    });

    this.encoder.configure({
      codec: `avc1.4d00${levelHex}`,  // Main Profile
      width: codedWidth,
      height: codedHeight,
      displayWidth,
      displayHeight,
      bitrate: targetBitrate,
      framerate: frameRate,
      bitrateMode: 'variable',
      // 'realtime' tells the encoder not to reorder frames, i.e. emit no B-frames.
      // Output then arrives in display order, so decode order == presentation order
      // and each chunk's timestamp is monotonic. This lets the worker derive a sample's
      // edit unit directly from its timestamp and use compositionTimeOffset 0, instead
      // of having to reconstruct a PTS/DTS reorder map (which the previous positional
      // editUnit assignment got wrong, scrambling playback after the first GOP).
      latencyMode: 'realtime',
      // Prefer the GPU H.264 encoder — typically several times faster than the software
      // (openh264) encoder Chrome falls back to under 'no-preference'. It's a hint: if no
      // hardware encoder is available Chrome silently uses software. We sanitize SPS[2]
      // regardless, so either encoder's parameter sets are accepted by MSE.
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'avc' },           // AVCC output; SPS/PPS via decoderConfig.description
    });
  }

  encodeFrame(frame: YUVFrame, timestampUs: number, forceKeyframe: boolean): void {
    if (this.encoderError) throw this.encoderError;

    const ySize = frame.codedWidth * frame.codedHeight;
    const uvW   = frame.codedWidth >> 1;
    const uvH   = frame.codedHeight >> 1; // always 4:2:0 output

    let cb420: Uint8ClampedArray;
    let cr420: Uint8ClampedArray;
    if (frame.chromaFormat === 2) {
      // 4:2:2 → 4:2:0: average each pair of chroma rows
      cb420 = new Uint8ClampedArray(uvW * uvH);
      cr420 = new Uint8ClampedArray(uvW * uvH);
      for (let row = 0; row < uvH; row++) {
        const s0 = row * 2 * uvW, s1 = s0 + uvW, dst = row * uvW;
        for (let col = 0; col < uvW; col++) {
          cb420[dst + col] = (frame.cb[s0 + col] + frame.cb[s1 + col]) >> 1;
          cr420[dst + col] = (frame.cr[s0 + col] + frame.cr[s1 + col]) >> 1;
        }
      }
    } else {
      cb420 = frame.cb;
      cr420 = frame.cr;
    }

    const uvSize = uvW * uvH;
    const buf = new Uint8Array(ySize + uvSize * 2);
    buf.set(frame.y,  0);
    buf.set(cb420, ySize);
    buf.set(cr420, ySize + uvSize);

    const videoFrame = new VideoFrame(buf, {
      format: 'I420',            // hardware encoders require 4:2:0
      codedWidth:    frame.codedWidth,
      codedHeight:   frame.codedHeight,
      displayWidth:  this.displayWidth,
      displayHeight: this.displayHeight,
      timestamp:     timestampUs,
      duration:      this.frameDurUs,
    });

    this.encoder.encode(videoFrame, { keyFrame: forceKeyframe });
    videoFrame.close();
  }

  /** Flush the encoder and return all accumulated encoded chunks. */
  async flush(): Promise<TranscodedChunk[]> {
    if (this.encoderError) throw this.encoderError;
    await this.encoder.flush();
    if (this.encoderError) throw this.encoderError;
    const chunks = this.pendingChunks.splice(0);
    return chunks;
  }

  get spspps(): SpsppsPair | null { return this._spspps; }
  /** Codec string from decoderConfig (e.g. "avc1.4d4028"), or null if not yet available. */
  get codecStr(): string | null { return this._codecStr; }

  close(): void {
    try { this.encoder.close(); } catch { /* ignore if already closed */ }
  }
}

/**
 * Parse SPS and PPS NALUs out of an AVCDecoderConfigurationRecord (avcC box payload).
 * Chrome's VideoEncoder supplies this in metadata.decoderConfig.description.
 */
function parseSPSPPSFromAvcC(buf: ArrayBuffer): { sps: Uint8Array | null; pps: Uint8Array | null } {
  const v = new DataView(buf);
  if (v.byteLength < 7) return { sps: null, pps: null };
  // Skip: configurationVersion(1) + AVCProfileIndication(1) +
  //       profile_compatibility(1) + AVCLevelIndication(1) + lengthSizeMinusOne(1)
  let i = 5;
  const numSPS = v.getUint8(i++) & 0x1f;
  if (numSPS === 0 || i + 2 > v.byteLength) return { sps: null, pps: null };
  const spsLen = v.getUint16(i, false); i += 2;
  if (i + spsLen > v.byteLength) return { sps: null, pps: null };
  const sps = new Uint8Array(buf, i, spsLen).slice(); i += spsLen;
  if (i >= v.byteLength) return { sps, pps: null };
  const numPPS = v.getUint8(i++);
  if (numPPS === 0 || i + 2 > v.byteLength) return { sps, pps: null };
  const ppsLen = v.getUint16(i, false); i += 2;
  if (i + ppsLen > v.byteLength) return { sps, pps: null };
  const pps = new Uint8Array(buf, i, ppsLen).slice();
  return { sps, pps };
}
