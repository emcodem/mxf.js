import { Mpeg2Decoder, YUVFrame } from '../codec/mpeg2-decoder.js';
import { Mpeg2Transcoder, TranscodedChunk } from '../codec/mpeg2-transcoder.js';

/** An MPEG-2 elementary-stream access unit. (System Item timecode is NOT threaded through the decoder:
 *  it is presentation-timeline metadata anchored by content-package edit unit in the worker, not a
 *  per-picture property — see demux-worker buildTcAnchors and src/parser/CLAUDE.md.) */
export interface PipelineInputFrame { data: ArrayBuffer }

export interface DecodeSegmentResult {
  chunks: TranscodedChunk[];
  /** Number of frames the decoder emitted (and the encoder queued) during this segment. */
  framesEmitted: number;
  /** Wall-clock spent in the synchronous decode + YUV-prep + encode-queue loop (ms). */
  decodeMs: number;
  /** Wall-clock spent draining the encoder via flush() (ms). */
  encodeMs: number;
}

/**
 * Common interface for transcode pipelines: the JS MPEG-2 pipeline and any wasm-backed plugin
 * pipeline both expose this shape so the worker can drive them identically.
 */
export interface ITranscodePipeline {
  readonly frameDurUs: number;
  readonly sps: Uint8Array;
  readonly pps: Uint8Array;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly codecString: string;
  reset(toFrame: number, useDisplayBase?: boolean): void;
  decodeSegment(
    videoFrames: PipelineInputFrame[],
    flushHeldAnchor: boolean,
    shouldAbort: () => boolean,
  ): Promise<DecodeSegmentResult>;
}

/**
 * The MPEG-2 → H.264 transcode pipeline, extracted from the demux worker.
 *
 * Wraps one persistent {@link Mpeg2Decoder} feeding one persistent {@link Mpeg2Transcoder}
 * (WebCodecs VideoEncoder targeting H.264 Main). Feeding consecutive segments into the SAME decoder
 * keeps its reference frames alive across segment boundaries — essential for Long-GOP MPEG-2, where
 * a fresh decoder starting mid-GOP never sees a sequence header and emits nothing. The decoder emits
 * in display order; each emitted frame is timestamped from a monotonic edit-unit counter and
 * re-encoded to H.264 (the encode callback runs inside decode(), driving the encoder).
 */
export class Mpeg2Pipeline {
  // Display-order frame counter; each emitted frame gets timestamp = counter * frameDurUs.
  // Reset to the target frame on seek.
  private editUnitCounter: bigint;
  // Set true at the start of each segment so the first emitted frame is encoded as a keyframe —
  // every MSE media segment must begin with a random-access point.
  private firstFrameOfSegment = true;
  // After a display-based reset (seek), the first emitted frame is the random-access I; its true
  // presentation edit unit is the keyframe's STORAGE edit unit + its temporal_reference (decode ≠
  // display order in Long-GOP). We can't know the temporal_reference until that frame decodes, so the
  // reset stashes the storage base here and the decode callback finalises the counter on the first
  // frame. null = no pending correction (forward playback, or a storage-based reset for scrub).
  private pendingDisplayBase: number | null = null;

  /** Microseconds per frame, derived from the edit rate. */
  readonly frameDurUs: number;
  readonly sps: Uint8Array;
  readonly pps: Uint8Array;
  /** MB-aligned coded dimensions (used for the avc1 box so it matches the SPS). */
  readonly codedWidth: number;
  readonly codedHeight: number;
  /** Display dimensions from the decoded frame. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Chroma format the stream opened with (1 = 4:2:0, 2 = 4:2:2). */
  readonly chromaFormat: number;
  /** Source coded dims — used for mid-stream format-change detection (encoder dims may differ). */
  private readonly _srcCodW: number;
  private readonly _srcCodH: number;

  private constructor(
    private readonly decoder: Mpeg2Decoder,
    private readonly transcoder: Mpeg2Transcoder,
    sps: Uint8Array,
    pps: Uint8Array,
    frameDurUs: number,
    startFrame: number,
    probe: YUVFrame,
  ) {
    this.sps = sps;
    this.pps = pps;
    this.frameDurUs = frameDurUs;
    this.editUnitCounter = BigInt(startFrame);
    this._srcCodW = probe.codedWidth;
    this._srcCodH = probe.codedHeight;
    // Encoder dims (may be half-res when scaleFactor=0.5 was used for Safari workaround).
    this.codedWidth    = transcoder.encoderCodW;
    this.codedHeight   = transcoder.encoderCodH;
    this.displayWidth  = transcoder.encoderDisplayW;
    this.displayHeight = transcoder.encoderDisplayH;
    this.chromaFormat = probe.chromaFormat;
  }

  /**
   * Probe-decode the first video frame to discover coded dimensions and chroma format. One-shot
   * throwaway decoder — its buffers are copied out (the decoder reuses them) and references aren't
   * retained. Returns null if the frame produced no picture.
   */
  static probeFirstFrame(frameData: ArrayBuffer): YUVFrame | null {
    let out: YUVFrame | null = null;
    const dec = new Mpeg2Decoder((yuv) => {
      if (!out) {
        out = {
          ...yuv,
          y: yuv.y.slice(), cb: yuv.cb.slice(), cr: yuv.cr.slice(),
        };
      }
    });
    dec.write(frameData);
    dec.decode();
    dec.flush();
    return out;
  }

  /**
   * Build the pipeline from a probed first frame: stand up the encoder, force it to emit SPS/PPS by
   * encoding the probe frame (the chunk is discarded), then create the persistent stream decoder.
   * Returns null (after closing the encoder) if the encoder produced no SPS/PPS.
   */
  static async create(
    probe: YUVFrame,
    editRateNumerator: number,
    editRateDenominator: number,
  ): Promise<Mpeg2Pipeline | null> {
    const fps = editRateNumerator / editRateDenominator;
    const frameDurUs = Math.round(editRateDenominator * 1_000_000 / editRateNumerator);

    let transcoder = new Mpeg2Transcoder(
      probe.codedWidth, probe.codedHeight,
      probe.width, probe.height,
      fps,
    );

    // Encode the first frame to force the encoder to emit SPS/PPS, then discard the chunk.
    transcoder.encodeFrame(probe, 0, true);
    await transcoder.flush();

    if (!transcoder.spspps) {
      // Safari 16.x VideoEncoder silently drops frames at ≥1920px wide — flush() resolves but zero
      // chunks are produced. Retry at ½ scale; all subsequent frames will be downscaled before encode.
      transcoder.close();
      console.warn(`[mxf.js] VideoEncoder silent failure at ${probe.codedWidth}×${probe.codedHeight} — retrying at ½ scale (Safari 16.x workaround)`);
      transcoder = new Mpeg2Transcoder(probe.codedWidth, probe.codedHeight, probe.width, probe.height, fps, 0.5);
      transcoder.encodeFrame(probe, 0, true);
      await transcoder.flush();
    }

    const spspps = transcoder.spspps;
    if (!spspps) {
      transcoder.close();
      return null;
    }

    // One persistent decoder for the whole stream; its onFrame callback drives the encoder.
    let pipeline: Mpeg2Pipeline;
    const decoder = new Mpeg2Decoder((decoded) => {
      // The transcoder + avc1 box are configured from the FIRST frame's coded dimensions and chroma
      // (the probe). A later frame that differs (multi-programme MXF, mid-stream resolution/chroma
      // change) would silently produce a wrong-sized VideoFrame or mis-downsampled chroma — surface
      // it as an error instead. (The decoder independently rejects an unsupported chroma_format.)
      if (decoded.codedWidth !== pipeline._srcCodW ||
          decoded.codedHeight !== pipeline._srcCodH ||
          decoded.chromaFormat !== pipeline.chromaFormat) {
        throw new Error(
          `Mid-stream format change not supported: a later frame is ${decoded.codedWidth}×${decoded.codedHeight} ` +
          `chroma=${decoded.chromaFormat}, but the stream opened as ${pipeline._srcCodW}×${pipeline._srcCodH} ` +
          `chroma=${pipeline.chromaFormat}`,
        );
      }
      // On the first frame after a display-based (seek) reset, finalise the counter to the keyframe's
      // true PRESENTATION edit unit: storage base + the I's temporal_reference. The decoder emits the
      // random-access I first (open-GOP leading B's are suppressed), so this frame IS that I.
      //
      // GOP-LENGTH-AGNOSTIC: each GOP is contiguous in both storage and display order, so the count of
      // frames before a GOP is identical in both ⟹ the GOP's display base equals the I's storage edit
      // unit, hence pres(I) = storageBase + tr_I for ANY GOP length / variable GOPs / any M. We anchor
      // once here and increment per emitted display-order frame thereafter (display order is globally
      // contiguous, so it stays correct across GOP boundaries of any size). ASSUMES standard MPEG-2
      // temporal_reference (reset per GOP, i.e. GOP headers present — true for XDCAM and effectively all
      // broadcast/camera MPEG-2) and that the seek target is a GOP-head random-access point. A GOP-
      // header-less stream (tr free-runs mod 1024) would need a different display-base derivation.
      if (pipeline.pendingDisplayBase !== null) {
        pipeline.editUnitCounter = BigInt(pipeline.pendingDisplayBase + decoded.temporalReference);
        pipeline.pendingDisplayBase = null;
      }
      const tsUs = Number(pipeline.editUnitCounter) * pipeline.frameDurUs;
      transcoder.encodeFrame(decoded, tsUs, pipeline.firstFrameOfSegment);
      pipeline.firstFrameOfSegment = false;
      pipeline.editUnitCounter++;
    });

    pipeline = new Mpeg2Pipeline(decoder, transcoder, spspps.sps, spspps.pps, frameDurUs, 0, probe);
    return pipeline;
  }

  /** Codec string derived from the actual SPS bytes (matches the constraint byte in the avcC box). */
  get codecString(): string {
    const p = this.sps[1].toString(16).padStart(2, '0');
    const c = this.sps[2].toString(16).padStart(2, '0');
    const l = this.sps[3].toString(16).padStart(2, '0');
    return `avc1.${p}${c}${l}`;
  }

  /**
   * Reset to a seek target: drop the decoder's reference frames (the post-seek fetch starts at a
   * keyframe carrying a fresh sequence header; stale references would corrupt the first pictures)
   * and resume the edit-unit counter from `toFrame` so timestamps continue from the seek point.
   */
  /**
   * Reset to a seek target. `toFrame` is the keyframe's STORAGE edit unit (the post-seek fetch reads
   * essence from there). With `useDisplayBase` (the default, for accurate seek / playback), the emitted
   * frames are labelled in PRESENTATION order: the random-access I is relabelled to `toFrame +
   * temporal_reference` on its first decode (Long-GOP stores in decode order, so the I displays a few
   * frames after its storage position), and subsequent display-order frames count up from there. Pass
   * `useDisplayBase = false` for throwaway scrub previews, which only need self-consistent labelling
   * (chunks + previewDone share the storage base) and whose accurate settle on release fixes the rest.
   */
  reset(toFrame: number, useDisplayBase = true): void {
    this.editUnitCounter = BigInt(toFrame);
    this.pendingDisplayBase = useDisplayBase ? toFrame : null;
    this.firstFrameOfSegment = true;
    this.decoder.reset();
  }

  /**
   * Decode a segment's worth of MPEG-2 ES frames to H.264 chunks.
   *
   * @param flushHeldAnchor Flush the decoder's held final I/P anchor now instead of carrying it to
   *   the next segment. True at end-of-stream and for throwaway/keyframe previews (no next segment
   *   will pick the anchor up); false during normal playback so display reordering stays correct.
   * @param shouldAbort Polled before each input frame; lets a seek/scrub bail the (synchronous,
   *   up-to-~50-frame) decode loop early so a preview can start promptly. flush() still runs so the
   *   shared encoder queue is drained clean — the caller drops the returned chunks if superseded.
   */
  async decodeSegment(
    videoFrames: PipelineInputFrame[],
    flushHeldAnchor: boolean,
    shouldAbort: () => boolean,
  ): Promise<DecodeSegmentResult> {
    // Force the first emitted frame of this segment to be a keyframe (random-access point).
    this.firstFrameOfSegment = true;
    const counterBefore = this.editUnitCounter;

    const decodeT0 = performance.now();
    for (let i = 0; i < videoFrames.length; i++) {
      if (shouldAbort()) break;
      // Yield to the worker's event loop every 5 frames so queued messages (seek, cancelPrefetch)
      // can run mid-decode. Without this, the fully synchronous decode loop (~32 ms/frame × 50 frames
      // = 1600 ms) blocks the worker thread: a seek arriving while buffering is queued but can't
      // execute until the entire loop finishes, so shouldAbort() never fires during the sync run and
      // the whole chunk decodes before the abort is seen. setTimeout(r,0) flushes the macrotask queue
      // (message handlers are macrotasks; Promise.resolve() only flushes microtasks and is not enough).
      if (i > 0 && i % 5 === 0) {
        await new Promise<void>(r => setTimeout(r, 0));
        if (shouldAbort()) break;
      }
      this.decoder.write(videoFrames[i].data);
      while (this.decoder.decode()) { /* onFrame fires inside decode(), driving the encoder */ }
    }
    const decodeMs = performance.now() - decodeT0;

    const flushT0 = performance.now();
    if (flushHeldAnchor) this.decoder.flush();
    const chunks = await this.transcoder.flush();
    // Derive each chunk's edit unit from its (monotonic, display-order) timestamp rather than its
    // array position — keeps the timeline correct across the held-anchor boundary where the number
    // of frames emitted per segment differs from the input count.
    for (const chunk of chunks) {
      chunk.editUnit = BigInt(Math.round(chunk.timestampUs / this.frameDurUs));
    }
    const encodeMs = performance.now() - flushT0;
    const framesEmitted = Number(this.editUnitCounter - counterBefore);

    return { chunks, framesEmitted, decodeMs, encodeMs };
  }
}
