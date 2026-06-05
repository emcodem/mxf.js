import { WasmFfmpegDecoder, RgbaFrame } from '../codec/wasm-ffmpeg-decoder.js';
import { Mpeg2Transcoder, TranscodedChunk } from '../codec/mpeg2-transcoder.js';
import type { ITranscodePipeline, DecodeSegmentResult } from './mpeg2-pipeline.js';

/**
 * Transcode pipeline backed by a wasm ffmpeg decoder.
 *
 * The wasm decoder handles B-frame reordering internally and outputs all frames in display order.
 * Each call to decoder.decode() may return 0, 1, or multiple frames depending on how many
 * display-order frames the B-frame reorder buffer releases (e.g. EU containing B2 may cause
 * both B2 and the previously-held P3 to be emitted together). All returned frames are encoded
 * sequentially — do NOT collapse or discard them.
 */
export class WasmTranscodePipeline implements ITranscodePipeline {
  private editUnitCounter: bigint;
  private firstFrameOfSegment = true;
  // After reset() (seek/scrub), suppress output until the first I-frame. Open-GOP leading
  // P-frames reference unavailable prior content and render as corruption, same issue the
  // native JS decoder solves with its suppressUntilKeyframe flag.
  private suppressUntilKey = true;

  readonly frameDurUs: number;
  readonly sps: Uint8Array;
  readonly pps: Uint8Array;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;

  private constructor(
    private readonly decoder: WasmFfmpegDecoder,
    private readonly transcoder: Mpeg2Transcoder,
    sps: Uint8Array,
    pps: Uint8Array,
    frameDurUs: number,
    codedWidth: number,
    codedHeight: number,
    displayWidth: number,
    displayHeight: number,
  ) {
    this.sps = sps;
    this.pps = pps;
    this.frameDurUs = frameDurUs;
    this.codedWidth = codedWidth;
    this.codedHeight = codedHeight;
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.editUnitCounter = 0n;
  }

  static async create(
    decoder: WasmFfmpegDecoder,
    firstFrameData: ArrayBuffer,
    editRateNumerator: number,
    editRateDenominator: number,
    displayWidth: number,
    displayHeight: number,
  ): Promise<WasmTranscodePipeline> {
    // Feed the first frame in 64 KB chunks. The mpegvideo parser emits a picture only when it
    // sees the next picture's start code; the sequence_end_code nudge forces it to flush.
    const PROBE_CHUNK = 65536;
    const probeBytes = new Uint8Array(firstFrameData);
    const firstHex = Array.from(probeBytes.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const probeFrames: RgbaFrame[] = [];
    for (let off = 0; off < probeBytes.length; off += PROBE_CHUNK) {
      probeFrames.push(...decoder.decode(probeBytes.subarray(off, Math.min(off + PROBE_CHUNK, probeBytes.length))));
      if (probeFrames.length) break;
    }
    if (!probeFrames.length) probeFrames.push(...decoder.nudgeParser());
    if (!probeFrames.length) probeFrames.push(...decoder.flush());

    // Reset so the persistent pipeline starts clean at frame 0.
    decoder.reset();

    if (!probeFrames.length) {
      throw new Error(
        `wasm decoder produced no frames from first video edit unit. ` +
        `Input: ${probeBytes.length} bytes, first 8: [${firstHex}]. ` +
        `Expected 00 00 01 b3 (MPEG-2 sequence header). ` +
        `Check ffmpegCodec name and that the MXF carries raw MPEG-2 ES.`
      );
    }

    // Use the first display-order frame for dimension probing.
    const first = probeFrames[0];
    const srcW = first.width;
    const srcH = first.height;
    if (!srcW || !srcH) throw new Error(`wasm decoder returned invalid dimensions: ${srcW}×${srcH}`);

    // MB-align coded dimensions for VideoEncoder (e.g. 1080 → 1088).
    const MB = 16;
    const cw = Math.ceil(srcW / MB) * MB;
    const ch = Math.ceil(srcH / MB) * MB;
    const dw = displayWidth || srcW;
    const dh = displayHeight || srcH;

    const fps = editRateNumerator / editRateDenominator;
    const frameDurUs = Math.round(editRateDenominator * 1_000_000 / editRateNumerator);

    const transcoder = new Mpeg2Transcoder(cw, ch, dw, dh, fps);
    transcoder.encodeRgbaFrame(first.data, srcW, srcH, 0, true);
    await transcoder.flush();
    const spspps = transcoder.spspps;
    if (!spspps) { transcoder.close(); throw new Error(`VideoEncoder did not produce SPS/PPS (coded=${cw}×${ch})`); }

    return new WasmTranscodePipeline(decoder, transcoder, spspps.sps, spspps.pps, frameDurUs, cw, ch, dw, dh);
  }

  get codecString(): string {
    const p = this.sps[1].toString(16).padStart(2, '0');
    const c = this.sps[2].toString(16).padStart(2, '0');
    const l = this.sps[3].toString(16).padStart(2, '0');
    return `avc1.${p}${c}${l}`;
  }

  reset(toFrame: number): void {
    this.editUnitCounter = BigInt(toFrame);
    this.firstFrameOfSegment = true;
    this.suppressUntilKey = true;
    this.decoder.reset();
  }

  async decodeSegment(
    videoFrames: { data: ArrayBuffer }[],
    flushDecoder: boolean,
    shouldAbort: () => boolean,
  ): Promise<DecodeSegmentResult> {
    this.firstFrameOfSegment = true;
    const counterBefore = this.editUnitCounter;
    const decodeT0 = performance.now();
    // pict_type: 1=I, 2=P, 3=B. Record which types come out per EU (e.g. "3:B" = 1 B-frame at EU 3).
    for (let i = 0; i < videoFrames.length; i++) {
      if (shouldAbort()) break;
      if (i > 0 && i % 5 === 0) {
        await new Promise<void>(r => setTimeout(r, 0));
        if (shouldAbort()) break;
      }
      const decoded = this.decoder.decode(new Uint8Array(videoFrames[i].data));
      for (const f of decoded) {
        // Drop leading non-keyframes from open GOPs — they reference unavailable prior content.
        if (this.suppressUntilKey) {
          if (f.pictType !== 1) continue;  // 1 = I-frame
          this.suppressUntilKey = false;
        }
        const tsUs = Number(this.editUnitCounter) * this.frameDurUs;
        this.transcoder.encodeRgbaFrame(f.data, f.width, f.height, tsUs, this.firstFrameOfSegment);
        this.firstFrameOfSegment = false;
        this.editUnitCounter++;
      }
    }
    if (flushDecoder) {
      // nudgeParser forces the mpegvideo parser to release its last buffered picture;
      // flush drains the decoder's reorder buffer.
      for (const f of [...this.decoder.nudgeParser(), ...this.decoder.flush()]) {
        if (this.suppressUntilKey) {
          if (f.pictType !== 1) continue;
          this.suppressUntilKey = false;
        }
        const tsUs = Number(this.editUnitCounter) * this.frameDurUs;
        this.transcoder.encodeRgbaFrame(f.data, f.width, f.height, tsUs, this.firstFrameOfSegment);
        this.firstFrameOfSegment = false;
        this.editUnitCounter++;
      }
    }
    const decodeMs = performance.now() - decodeT0;

    const flushT0 = performance.now();
    const chunks = await this.transcoder.flush();
    for (const chunk of chunks) {
      chunk.editUnit = BigInt(Math.round(chunk.timestampUs / this.frameDurUs));
    }
    const encodeMs = performance.now() - flushT0;
    const framesEmitted = Number(this.editUnitCounter - counterBefore);

    return { chunks, framesEmitted, decodeMs, encodeMs };
  }
}

export type { TranscodedChunk };
