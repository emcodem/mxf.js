import { WasmFfmpegDecoder, DecodedFrame } from '../codec/wasm-ffmpeg-decoder.js';
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
 *
 * Every emitted frame is re-encoded as an H.264 IDR keyframe (see encodeDecodedFrame) — no P-frames
 * at all. This wasm-plugin path currently serves ProRes exclusively, and ProRes has no inter-frame
 * prediction in its own bitstream (every source frame is already independently decodable), so
 * introducing an H.264 P-frame reference chain here is a pure choice, not a technical requirement —
 * unlike Mpeg2Pipeline, whose Long-GOP source genuinely has temporal structure worth preserving.
 * Real repro testing (todo_transcode_stall_and_fallback.md Issue A) found that a P-frame chain
 * introduced here reliably exposed a Chrome D3D11 hardware H.264 decoder reliability bug under
 * sustained MSE buffer underflow (which this pipeline's below-realtime decode throughput causes
 * often): once the decoder failed to resume from one particular underflow, it stayed permanently
 * wedged, matching the watchdog's own diagnosis of "a decode-dependency break behind the playhead".
 * All-intra output has no such dependency to break — any available frame is decodable on its own,
 * so an underflow is just a transient stall again instead of a permanent one (confirmed: 100%
 * reliable full playthrough vs. reliably wedging within the first ~10s with P-frames). The bitrate
 * cost is real (H.264 without inter-prediction can't exploit whatever temporal pixel redundancy
 * ProRes's own encode ignored) but is the right trade against a hard freeze.
 */
export class WasmTranscodePipeline implements ITranscodePipeline {
  private editUnitCounter: bigint;
  // After reset() (seek/scrub), suppress output until the first I-frame. Open-GOP leading
  // P-frames reference unavailable prior content and render as corruption, same issue the
  // native JS decoder solves with its suppressUntilKeyframe flag. All-intra codecs (e.g. ProRes)
  // never trip this: every frame is pictType 1, so the very first frame clears it immediately.
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
    private readonly packetMode: 'stream' | 'frame',
    // Only valid when the transcoder is at scaleFactor 1.0 — encodeI420Frame doesn't implement the
    // Safari half-scale path (see Mpeg2Transcoder.encodeI420Frame). Decided once at create() from
    // whether the decoder emitted 'i420' for the probe frame AND no half-scale retry was needed.
    private readonly useI420: boolean,
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
    packetMode: 'stream' | 'frame' = 'stream',
  ): Promise<WasmTranscodePipeline> {
    const probeBytes = new Uint8Array(firstFrameData);
    const firstHex = Array.from(probeBytes.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const probeFrames: DecodedFrame[] = [];
    if (packetMode === 'frame') {
      // One edit unit IS one complete packet for a frame-wrapped, parser-less codec (e.g. ProRes)
      // — feed it whole and expect a frame back immediately. No parser to nudge.
      probeFrames.push(...decoder.decode(probeBytes));
    } else {
      // Feed the first frame in 64 KB chunks. The mpegvideo parser emits a picture only when it
      // sees the next picture's start code; the sequence_end_code nudge forces it to flush.
      const PROBE_CHUNK = 65536;
      for (let off = 0; off < probeBytes.length; off += PROBE_CHUNK) {
        probeFrames.push(...decoder.decode(probeBytes.subarray(off, Math.min(off + PROBE_CHUNK, probeBytes.length))));
        if (probeFrames.length) break;
      }
      if (!probeFrames.length) probeFrames.push(...decoder.nudgeParser());
    }
    if (!probeFrames.length) probeFrames.push(...decoder.flush());

    // Reset so the persistent pipeline starts clean at frame 0.
    decoder.reset();

    if (!probeFrames.length) {
      const hint = decoder.ffmpegCodec === 'mpeg2video' ? ' Expected 00 00 01 b3 (MPEG-2 sequence header).' : '';
      throw new Error(
        `wasm decoder ('${decoder.ffmpegCodec}', packetMode='${packetMode}') produced no frames from ` +
        `first video edit unit. Input: ${probeBytes.length} bytes, first 8: [${firstHex}].${hint} ` +
        `Check ffmpegCodec name and that the MXF carries raw '${decoder.ffmpegCodec}' elementary-stream packets.`
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

    // See Mpeg2Transcoder.preferredAcceleration(): requesting hardware unconditionally fails
    // configure() on machines without a VAAPI encoder (WSL, headless Linux, VMs).
    const accel = await Mpeg2Transcoder.preferredAcceleration(cw, ch, dw, dh, fps);
    let transcoder = new Mpeg2Transcoder(cw, ch, dw, dh, fps, 1.0, accel);
    let usedHalfScaleRetry = false;
    if (first.format === 'i420') {
      transcoder.encodeI420Frame(first.data, srcW, srcH, 0, true);
    } else {
      transcoder.encodeRgbaFrame(first.data, srcW, srcH, 0, true);
    }
    await transcoder.flush();

    if (!transcoder.spspps) {
      // Safari 16.x VideoEncoder silently drops frames at ≥1920px wide. Retry at ½ scale.
      transcoder.close();
      console.warn(`[mxf.js] VideoEncoder silent failure at ${cw}×${ch} — retrying at ½ scale (Safari 16.x workaround)`);
      transcoder = new Mpeg2Transcoder(cw, ch, dw, dh, fps, 0.5);
      usedHalfScaleRetry = true;
      // This probe encode's output is never captured (flush()'s return value is discarded below) —
      // only its dimensions matter, to make the encoder configure and emit SPS/PPS. So pixel content
      // is irrelevant: encodeRgbaFrame's scaled (2×2-average) path is already implemented, while
      // encodeI420Frame's is not — always go through encodeRgbaFrame here, synthesizing a neutral
      // buffer when the decoder runs in i420 mode (no rgba bytes available for `first`).
      const rgbaProbe = first.format === 'rgba' ? first.data : new Uint8ClampedArray(srcW * srcH * 4).fill(128);
      transcoder.encodeRgbaFrame(rgbaProbe, srcW, srcH, 0, true);
      await transcoder.flush();
    }

    const spspps = transcoder.spspps;
    if (!spspps) { transcoder.close(); throw new Error(`VideoEncoder did not produce SPS/PPS (coded=${cw}×${ch})`); }

    // encodeI420Frame doesn't implement the half-scale path, so the retry always falls back to RGBA.
    const useI420 = first.format === 'i420' && !usedHalfScaleRetry;

    return new WasmTranscodePipeline(
      decoder, transcoder, packetMode, useI420, spspps.sps, spspps.pps, frameDurUs,
      transcoder.encoderCodW, transcoder.encoderCodH,
      transcoder.encoderDisplayW, transcoder.encoderDisplayH,
    );
  }

  get codecString(): string {
    const p = this.sps[1].toString(16).padStart(2, '0');
    const c = this.sps[2].toString(16).padStart(2, '0');
    const l = this.sps[3].toString(16).padStart(2, '0');
    return `avc1.${p}${c}${l}`;
  }

  get encodeQueueSize(): number { return this.transcoder.encodeQueueSize; }

  // `useDisplayBase` is accepted for interface parity with the JS pipeline but unused: the wasm decoder
  // reorders internally and does not expose per-picture temporal_reference, so it cannot relabel to the
  // keyframe's true presentation edit unit. Seek labelling stays storage-based for this path.
  reset(toFrame: number, _useDisplayBase = true): void {
    this.editUnitCounter = BigInt(toFrame);
    this.suppressUntilKey = true;
    this.decoder.reset();
  }

  private encodeDecodedFrame(f: DecodedFrame, tsUs: number): void {
    // Always a keyframe — see the class doc comment for why.
    if (this.useI420) {
      this.transcoder.encodeI420Frame(f.data, f.width, f.height, tsUs, true);
    } else {
      this.transcoder.encodeRgbaFrame(f.data, f.width, f.height, tsUs, true);
    }
  }

  async decodeSegment(
    videoFrames: { data: ArrayBuffer }[],
    flushDecoder: boolean,
    shouldAbort: () => boolean,
  ): Promise<DecodeSegmentResult> {
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
        // All-intra codecs (pictType always 1) never hit this branch.
        if (this.suppressUntilKey) {
          if (f.pictType !== 1) continue;  // 1 = I-frame
          this.suppressUntilKey = false;
        }
        const tsUs = Number(this.editUnitCounter) * this.frameDurUs;
        this.encodeDecodedFrame(f, tsUs);
        this.editUnitCounter++;
      }
    }
    if (flushDecoder) {
      // nudgeParser forces the mpegvideo parser to release its last buffered picture — only
      // meaningful for a stream-oriented parser; a frame-mode packetless codec (e.g. ProRes) has
      // already emitted every frame from the main loop above, so skip it. flush() still drains any
      // decoder-side buffering either way.
      const flushed = this.packetMode === 'frame' ? this.decoder.flush() : [...this.decoder.nudgeParser(), ...this.decoder.flush()];
      for (const f of flushed) {
        if (this.suppressUntilKey) {
          if (f.pictType !== 1) continue;
          this.suppressUntilKey = false;
        }
        const tsUs = Number(this.editUnitCounter) * this.frameDurUs;
        this.encodeDecodedFrame(f, tsUs);
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
