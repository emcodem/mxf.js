import type { YUVFrame } from './mpeg2-decoder.js';
import { addSpsFrameCropping } from '../essence/avc-tools.js';

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
 *
 * `scaleFactor` (default 1.0) encodes at a fraction of the source dimensions.  Safari 16.x
 * VideoEncoder silently produces zero output for frames ≥1920px wide; the pipelines detect
 * this and retry at 0.5× via this parameter.  Chrome is unaffected (scaleFactor stays 1.0).
 */
export class Mpeg2Transcoder {
  private encoder: VideoEncoder;
  private pendingChunks: TranscodedChunk[] = [];
  private _spspps: SpsppsPair | null = null;
  private _codecStr: string | null = null;
  private frameDurUs: number;
  // Encoder (output) dimensions — may be smaller than source when scaleFactor < 1.
  private codedWidth: number;
  private codedHeight: number;
  private displayWidth: number;
  private displayHeight: number;
  // Scale factor applied to source dims to get encoder dims (1 = no scaling). The encode methods
  // read source dims from each frame directly, so only the factor itself needs to be retained.
  private readonly _scale: number;
  private encoderError: Error | null = null;

  // Persistent per-frame scratch, reused across encodeFrame() calls to avoid ~3.5 MB of allocation
  // per frame (the dominant GC pressure during a decode/scrub burst). Sized lazily on first use;
  // the pipeline rejects mid-stream format changes, so the dimensions never change after that.
  // `new VideoFrame(bufferSource, …)` copies the pixel data into the frame's own storage at
  // construction (WebCodecs spec), so reusing `interleaveBuf` on the next call is safe.
  private interleaveBuf: Uint8Array | null = null;
  private cb420: Uint8ClampedArray | null = null;
  private cr420: Uint8ClampedArray | null = null;

  constructor(
    codedWidth: number,
    codedHeight: number,
    displayWidth: number,
    displayHeight: number,
    frameRate: number,
    scaleFactor: number = 1.0,
  ) {
    this._scale = scaleFactor;

    // Scale encoder dimensions (MB-align after scaling).
    const MB = 16;
    const ew  = Math.ceil(codedWidth   * scaleFactor / MB) * MB;
    const eh  = Math.ceil(codedHeight  * scaleFactor / MB) * MB;
    const edw = Math.round(displayWidth  * scaleFactor);
    const edh = Math.round(displayHeight * scaleFactor);

    this.codedWidth    = ew;
    this.codedHeight   = eh;
    this.displayWidth  = edw;
    this.displayHeight = edh;
    this.frameDurUs    = Math.round(1_000_000 / frameRate);

    // H.264 level is constrained by MaxFS (macroblocks per frame) AND MaxMBPS
    // (macroblocks per second). Pixel-rate alone is misleading for non-standard
    // resolutions like 1920×544 (4080 MBs/frame > Level 3.1's limit of 3600).
    const mbPerFrame = Math.ceil(ew / MB) * Math.ceil(eh / MB);
    const mbPerSec   = mbPerFrame * frameRate;
    let levelHex: string;
    if      (mbPerFrame <= 3600 && mbPerSec <= 108_000)  levelHex = '1f'; // Level 3.1: ≤1280×720
    else if (mbPerFrame <= 8192 && mbPerSec <= 245_760)  levelHex = '28'; // Level 4.0: ≤1920×1088
    else if (mbPerFrame <= 8704 && mbPerSec <= 522_240)  levelHex = '2a'; // Level 4.2
    else                                                  levelHex = '33'; // Level 5.1

    const targetBitrate = Math.min(50_000_000, Math.round(ew * eh * frameRate * 0.15));

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
            // Chrome's VideoEncoder never emits frame_cropping even when displayHeight < codedHeight
            // (e.g. 1080 vs the MB-padded 1088). Without it the player renders the padded bottom rows
            // (the MPEG-2 encoder edge-replicates the last line there → a smeared bottom MB row).
            // Inject the crop so the SPS's natural size matches the display dims declared in avc1/tkhd.
            const cropped = addSpsFrameCropping(
              sps, this.codedWidth, this.codedHeight, this.displayWidth, this.displayHeight,
            );
            this._spspps = { sps: cropped ?? sps, pps: result.pps };
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
      error: (e) => {
        console.error('[Mpeg2Transcoder] VideoEncoder error:', e);
        this.encoderError = e;
      },
    });

    if (scaleFactor === 1.0) {
      // Full-resolution path — all performance hints are safe on Chrome/Chromium.
      this.encoder.configure({
        codec: `avc1.4d00${levelHex}`,  // Main Profile
        width: ew,
        height: eh,
        displayWidth:  edw,
        displayHeight: edh,
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
    } else {
      // Safari 16.x workaround path — latencyMode/hardwareAcceleration/bitrateMode cause silent
      // encoding failures in Safari Workers even at half resolution. Use minimal configure options
      // that match the diagnostic test that confirmed work in Safari (640×480, 1280×720, 960×544).
      // The SPS frame-crop offset (to hide the 4-row MB-padding from display) is applied via
      // addSpsFrameCropping in the output callback, so displayWidth/Height are not needed here.
      this.encoder.configure({
        codec: `avc1.4d00${levelHex}`,
        width: ew,
        height: eh,
        bitrate: targetBitrate,
        framerate: frameRate,
        avc: { format: 'avc' },
      });
    }
  }

  encodeFrame(frame: YUVFrame, timestampUs: number, forceKeyframe: boolean): void {
    if (this.encoderError) throw this.encoderError;

    // Only 4:2:0 (1, pass-through) and 4:2:2 (2, downsampled below) are handled. The decoder already
    // rejects other chroma formats, but guard here too: the `else` branch assumes 4:2:0 layout, so an
    // unexpected format would silently mis-interpret the chroma planes rather than fail.
    if (frame.chromaFormat !== 1 && frame.chromaFormat !== 2) {
      throw new Error(`Transcoder: unsupported chroma format ${frame.chromaFormat} (only 4:2:0 and 4:2:2)`);
    }

    const srcW  = frame.codedWidth;
    const srcH  = frame.codedHeight;
    const uvW   = srcW >> 1;
    const uvH   = srcH >> 1; // always 4:2:0 output
    const uvSize = uvW * uvH;

    let cb420: Uint8ClampedArray;
    let cr420: Uint8ClampedArray;
    if (frame.chromaFormat === 2) {
      // 4:2:2 → 4:2:0: average each pair of chroma rows (into persistent scratch).
      if (this.cb420 === null || this.cb420.length !== uvSize) {
        this.cb420 = new Uint8ClampedArray(uvSize);
        this.cr420 = new Uint8ClampedArray(uvSize);
      }
      cb420 = this.cb420;
      cr420 = this.cr420!;
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

    const ew = this.codedWidth;
    const eh = this.codedHeight;
    const eYSize  = ew * eh;
    const eUvSize = (ew >> 1) * (eh >> 1);
    const bufLen  = eYSize + eUvSize * 2;

    if (this.interleaveBuf === null || this.interleaveBuf.length !== bufLen) {
      this.interleaveBuf = new Uint8Array(bufLen);
    }
    const buf = this.interleaveBuf;

    if (this._scale !== 1) {
      // Downscale 4:2:0 I420 from source dims to encoder dims via 2×2 box filter.
      this._downscale420(frame.y, cb420, cr420, srcW);
    } else {
      buf.set(frame.y,  0);
      buf.set(cb420, eYSize);
      buf.set(cr420, eYSize + eUvSize);
    }

    const videoFrame = new VideoFrame(buf, {
      format: 'I420',            // hardware encoders require 4:2:0
      codedWidth:    ew,
      codedHeight:   eh,
      displayWidth:  this.displayWidth,
      displayHeight: this.displayHeight,
      timestamp:     timestampUs,
      duration:      this.frameDurUs,
    });

    this.encoder.encode(videoFrame, { keyFrame: forceKeyframe });
    videoFrame.close();
  }

  /**
   * Encode an RGBA frame from a wasm decoder.
   *
   * Chrome's VideoEncoder (H.264) only accepts I420/NV12 input — it silently drops RGBA frames
   * and never emits SPS/PPS. We therefore convert RGBA→I420 here in JS (BT.601 limited-range,
   * 2×2 chroma averaging) and reuse interleaveBuf to avoid per-frame allocation.
   *
   * The source RGBA is at `srcWidth × srcHeight` (the decoded display size, e.g. 1440×1080).
   * The transcoder's coded dimensions `codedWidth × codedHeight` are MB-aligned (e.g. 1440×1088).
   * Any extra rows are zero-filled (Y=16/black, Cb=Cr=128/neutral) so the encoder sees a valid
   * full-MB frame; the display crop in the avc1 box hides the padded rows from the viewer.
   *
   * When scaleFactor < 1, the RGBA→I420 conversion outputs at encoder dims directly (2×2 block
   * average in both spatial dimensions), avoiding a full-res intermediate buffer.
   */
  encodeRgbaFrame(rgba: Uint8ClampedArray, srcWidth: number, srcHeight: number, timestampUs: number, forceKeyframe: boolean): void {
    if (this.encoderError) throw this.encoderError;

    const cw     = this.codedWidth;
    const ch     = this.codedHeight;
    const ySize  = cw * ch;
    const uvW    = cw >> 1;
    const uvH    = ch >> 1;
    const uvSize = uvW * uvH;
    const bufLen = ySize + uvSize * 2;

    if (this.interleaveBuf === null || this.interleaveBuf.length !== bufLen) {
      this.interleaveBuf = new Uint8Array(bufLen);
      // Pre-fill entire buffer with black (Y=16) and neutral chroma (128) so any
      // padding rows below the active picture are already correct without per-row branching.
      this.interleaveBuf.fill(16,  0,        ySize);
      this.interleaveBuf.fill(128, ySize);
    }
    const buf = this.interleaveBuf;

    if (this._scale !== 1) {
      // Scaled path: RGBA → half-res I420 in a single 2×2 averaging pass.
      // Pre-fill with black/neutral is done above; only write active rows.
      const dstH    = Math.min(ch, Math.ceil(srcHeight / 2));
      const dstUvH  = Math.min(uvH, Math.ceil(srcHeight / 4));
      const dstUvW  = uvW;

      // Y plane: 2×2 block average RGBA → Y luma
      for (let r = 0; r < dstH; r++) {
        for (let c = 0; c < cw; c++) {
          const sr0 = Math.min(r * 2,     srcHeight - 1) * srcWidth;
          const sr1 = Math.min(r * 2 + 1, srcHeight - 1) * srcWidth;
          const sc0 = Math.min(c * 2,     srcWidth  - 1);
          const sc1 = Math.min(c * 2 + 1, srcWidth  - 1);
          const p0 = (sr0 + sc0) * 4, p1 = (sr0 + sc1) * 4;
          const p2 = (sr1 + sc0) * 4, p3 = (sr1 + sc1) * 4;
          const rr = (rgba[p0] + rgba[p1] + rgba[p2] + rgba[p3]) >> 2;
          const gg = (rgba[p0+1] + rgba[p1+1] + rgba[p2+1] + rgba[p3+1]) >> 2;
          const bb = (rgba[p0+2] + rgba[p1+2] + rgba[p2+2] + rgba[p3+2]) >> 2;
          buf[r * cw + c] = ((66 * rr + 129 * gg + 25 * bb + 128) >> 8) + 16;
        }
      }

      // Cb/Cr planes: 4×4 block average RGBA → chroma
      for (let uy = 0; uy < dstUvH; uy++) {
        for (let ux = 0; ux < dstUvW; ux++) {
          let rr = 0, gg = 0, bb = 0;
          for (let dr = 0; dr < 4; dr++) {
            const sr = Math.min(uy * 4 + dr, srcHeight - 1) * srcWidth;
            for (let dc = 0; dc < 4; dc++) {
              const sc = Math.min(ux * 4 + dc, srcWidth - 1);
              const p = (sr + sc) * 4;
              rr += rgba[p]; gg += rgba[p+1]; bb += rgba[p+2];
            }
          }
          rr >>= 4; gg >>= 4; bb >>= 4;
          buf[ySize          + uy * dstUvW + ux] = ((-38 * rr - 74 * gg + 112 * bb + 128) >> 8) + 128;
          buf[ySize + uvSize + uy * dstUvW + ux] = ((112 * rr - 94 * gg  - 18 * bb + 128) >> 8) + 128;
        }
      }
    } else {
      // Full-resolution path (unchanged from original).
      for (let row = 0; row < srcHeight; row++) {
        for (let col = 0; col < srcWidth; col++) {
          const si = (row * srcWidth + col) * 4;
          const r = rgba[si], g = rgba[si + 1], b = rgba[si + 2];
          buf[row * cw + col] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
        }
      }
      const uvSrcH = srcHeight >> 1;
      const uvSrcW = srcWidth  >> 1;
      for (let uy = 0; uy < uvSrcH; uy++) {
        for (let ux = 0; ux < uvSrcW; ux++) {
          const p0 = (uy * 2 * srcWidth + ux * 2) * 4;
          const p1 = p0 + 4;
          const p2 = p0 + srcWidth * 4;
          const p3 = p2 + 4;
          const r = (rgba[p0] + rgba[p1] + rgba[p2] + rgba[p3]) >> 2;
          const g = (rgba[p0 + 1] + rgba[p1 + 1] + rgba[p2 + 1] + rgba[p3 + 1]) >> 2;
          const b = (rgba[p0 + 2] + rgba[p1 + 2] + rgba[p2 + 2] + rgba[p3 + 2]) >> 2;
          buf[ySize          + uy * uvW + ux] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
          buf[ySize + uvSize + uy * uvW + ux] = ((112 * r - 94 * g  - 18 * b + 128) >> 8) + 128;
        }
      }
    }

    const videoFrame = new VideoFrame(buf, {
      format:       'I420',
      codedWidth:    cw,
      codedHeight:   ch,
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

  /** Encoder (output) coded dimensions — may differ from source when scaleFactor < 1. */
  get encoderCodW(): number { return this.codedWidth; }
  get encoderCodH(): number { return this.codedHeight; }
  get encoderDisplayW(): number { return this.displayWidth; }
  get encoderDisplayH(): number { return this.displayHeight; }

  close(): void {
    try { this.encoder.close(); } catch { /* ignore if already closed */ }
  }

  /**
   * 2× box-filter downscale: writes source 4:2:0 I420 planes into this.interleaveBuf
   * at encoder dimensions (half the source in each axis).
   * Called only when scaleFactor < 1; assumes interleaveBuf is already sized for encoder dims.
   *
   * Reads source rows/cols without bounds-clamping (unlike encodeRgbaFrame's scaled path). Safe
   * because the MPEG-2 decoder always emits MB-aligned coded dims and the retry only fires for the
   * ≥1920-wide content that triggers the Safari bug (1920×1088 → 960×544, an exact 2× on both axes).
   * A source whose half is not MB-aligned (srcH not a multiple of 32) would read one MB row past the
   * plane; no such MPEG-2 resolution reaches this path.
   */
  private _downscale420(
    srcY: Uint8ClampedArray | Uint8Array,
    srcCb: Uint8ClampedArray,
    srcCr: Uint8ClampedArray,
    srcW: number,
  ): void {
    const buf    = this.interleaveBuf!;
    const dstW   = this.codedWidth;
    const dstH   = this.codedHeight;
    const dstUvW = dstW >> 1;
    const dstUvH = dstH >> 1;
    const dstYSz = dstW * dstH;
    const dstUvSz = dstUvW * dstUvH;
    const srcUvW = srcW >> 1;

    // Y plane: 2×2 box filter from source
    for (let r = 0; r < dstH; r++) {
      const sr0 = (r * 2)     * srcW;
      const sr1 = (r * 2 + 1) * srcW;
      for (let c = 0; c < dstW; c++) {
        const sc = c * 2;
        buf[r * dstW + c] = (srcY[sr0 + sc] + srcY[sr0 + sc + 1] + srcY[sr1 + sc] + srcY[sr1 + sc + 1] + 2) >> 2;
      }
    }

    // Cb/Cr planes: source 4:2:0 chroma is at srcW/2 × srcH/2; halve again via 2×2 box filter
    for (let r = 0; r < dstUvH; r++) {
      const sr0 = (r * 2)     * srcUvW;
      const sr1 = (r * 2 + 1) * srcUvW;
      for (let c = 0; c < dstUvW; c++) {
        const sc = c * 2;
        buf[dstYSz          + r * dstUvW + c] = (srcCb[sr0 + sc] + srcCb[sr0 + sc + 1] + srcCb[sr1 + sc] + srcCb[sr1 + sc + 1] + 2) >> 2;
        buf[dstYSz + dstUvSz + r * dstUvW + c] = (srcCr[sr0 + sc] + srcCr[sr0 + sc + 1] + srcCr[sr1 + sc] + srcCr[sr1 + sc + 1] + 2) >> 2;
      }
    }
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
