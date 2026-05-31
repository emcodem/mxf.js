import { Mpeg2Decoder, YUVFrame } from '../codec/mpeg2-decoder.js';
import { Mpeg2Transcoder, TranscodedChunk } from '../codec/mpeg2-transcoder.js';

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
    this.codedWidth = probe.codedWidth;
    this.codedHeight = probe.codedHeight;
    this.displayWidth = probe.width;
    this.displayHeight = probe.height;
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
          y: yuv.y.slice(), cb: yuv.cb.slice(), cr: yuv.cr.slice(),
          codedWidth: yuv.codedWidth, codedHeight: yuv.codedHeight,
          width: yuv.width, height: yuv.height,
          chromaFormat: yuv.chromaFormat, isKeyframe: yuv.isKeyframe,
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

    const transcoder = new Mpeg2Transcoder(
      probe.codedWidth, probe.codedHeight,
      probe.width, probe.height,
      fps,
    );

    // Encode the first frame to force the encoder to emit SPS/PPS, then discard the chunk.
    transcoder.encodeFrame(probe, 0, true);
    await transcoder.flush();
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
      if (decoded.codedWidth !== pipeline.codedWidth ||
          decoded.codedHeight !== pipeline.codedHeight ||
          decoded.chromaFormat !== pipeline.chromaFormat) {
        throw new Error(
          `Mid-stream format change not supported: a later frame is ${decoded.codedWidth}×${decoded.codedHeight} ` +
          `chroma=${decoded.chromaFormat}, but the stream opened as ${pipeline.codedWidth}×${pipeline.codedHeight} ` +
          `chroma=${pipeline.chromaFormat}`,
        );
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
  reset(toFrame: number): void {
    this.editUnitCounter = BigInt(toFrame);
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
    videoFrames: { data: ArrayBuffer }[],
    flushHeldAnchor: boolean,
    shouldAbort: () => boolean,
  ): Promise<DecodeSegmentResult> {
    // Force the first emitted frame of this segment to be a keyframe (random-access point).
    this.firstFrameOfSegment = true;
    const counterBefore = this.editUnitCounter;

    const decodeT0 = performance.now();
    for (const vf of videoFrames) {
      if (shouldAbort()) break;
      this.decoder.write(vf.data);
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
