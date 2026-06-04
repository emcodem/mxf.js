import { ILoader } from '../loader/loader.js';
import { MxfBootstrap } from '../mxf-file.js';
import { KLVIterator } from '../core/klv.js';
import { decodeBerLength } from '../core/ber.js';
import { isPictureEssence, isSoundEssence, isAes3Sound, isPartitionPack, isFill, isSystemItem } from '../core/ul.js';
import { resolveFrameOffset, resolveExactFrameOffset, IndexTableSegment } from '../parser/index-table.js';
import { parseSystemItemTimecode, Timecode } from '../parser/timecode.js';
import { SEQ_WINDOW, SEQ_HARD_CAP } from '../core/constants.js';

export interface EssenceFrame {
  trackType: 'video' | 'audio';
  editUnit: bigint;
  /** Presentation timestamp in edit units */
  pts: bigint;
  /** Decode timestamp in edit units */
  dts: bigint;
  isKeyframe: boolean;
  data: ArrayBuffer;
  /**
   * Video only: the per-frame SMPTE 12M timecode parsed from this content package's System Item
   * (when present). This is the authoritative per-frame source timecode and may be discontinuous
   * ("jump"); absent when the file has no system item or its layout isn't recognised (best effort).
   */
  systemTimecode?: Timecode;
  /** Audio only: true when the sound element is AES3-wrapped (SMPTE 331M / D-10) rather than plain PCM. */
  aes3?: boolean;
  /**
   * Absolute file offset of this element's KLV. Populated on every emitted frame; the no-index
   * (Tier-3) long-GOP path uses it to record discovered keyframe byte offsets in a sparse index.
   */
  byteOffset?: bigint;
}

export class EssenceExtractor {
  private readonly loader: ILoader;
  private readonly bootstrap: MxfBootstrap;
  /**
   * Track-number bytes (key[12..15]) of the first picture element seen, so a file with more than one
   * video track is demuxed as a single stream. Without this, every picture element increments the
   * edit-unit counter, so two video tracks double-count edit units and misalign every index offset.
   * Audio is deliberately NOT locked this way: separate-mono PCM carries each channel as its own
   * sound element per edit unit, and the PCM decoder relies on seeing all of them.
   */
  private videoTrackKey: Uint8Array | null = null;
  /** Optional cancellation signal; aborting it cancels in-flight reads (seek/scrub supersession). */
  private readonly signal?: AbortSignal;
  /** Rounded timecode base (frames/sec) for decoding System Item SMPTE 12M timecodes. */
  private readonly tcBase: number;

  constructor(loader: ILoader, bootstrap: MxfBootstrap, signal?: AbortSignal) {
    this.loader = loader;
    this.bootstrap = bootstrap;
    this.signal = signal;
    // Rounded timecode base for System Item decode. Defensive against a bootstrap without metadata
    // (some unit-test fixtures stub only the fields they exercise).
    const n = bootstrap.metadata?.editRateNumerator ?? 0;
    const d = bootstrap.metadata?.editRateDenominator ?? 0;
    this.tcBase = d > 0 ? Math.round(n / d) : 0;
  }

  /**
   * Fetch frames starting from startFrame, up to frameCount frames.
   * Yields EssenceFrames for video and audio interleaved as they appear in the file.
   *
   * When `exact` is true the byte range begins at startFrame's own offset rather than
   * snapping back to the nearest keyframe. This is required when feeding a continuous
   * stream into one persistent decoder (the MPEG-2 transcode path): snapping would re-read
   * pictures the decoder has already consumed. The default (false) preserves seek-to-keyframe
   * behaviour for callers that need a random-access point.
   */
  async *fetchFrames(
    startFrame: bigint,
    frameCount: number,
    exact = false,
    fromByteOffset?: bigint,
  ): AsyncGenerator<EssenceFrame> {
    const { indexSegments, essenceStart, indexMode } = this.bootstrap;

    // 'none' (no usable index — e.g. growing/live files) always scans sequentially, even if a
    // stray/partial index segment exists, since it can't be trusted to map frames to offsets.
    // `fromByteOffset` lets the no-index long-GOP path resume a scan at a known keyframe byte,
    // with `startFrame` asserting the edit unit at that byte (see SparseKeyframeIndex).
    if (indexMode !== 'none' && indexSegments.length > 0) {
      yield* this.fetchFramesViaIndex(startFrame, frameCount, indexSegments, essenceStart, exact);
    } else {
      yield* this.fetchFramesSequential(startFrame, frameCount, essenceStart, fromByteOffset);
    }
  }

  private async *fetchFramesViaIndex(
    startFrame: bigint,
    frameCount: number,
    segments: IndexTableSegment[],
    essenceContainerStart: bigint,
    exact: boolean
  ): AsyncGenerator<EssenceFrame> {
    const resolve = exact ? resolveExactFrameOffset : resolveFrameOffset;
    const vid = this.bootstrap.essenceBodySID;
    const resolved = resolve(segments, startFrame, essenceContainerStart, vid);
    if (!resolved) return;

    // Determine end byte: the EXACT offset of the frame AFTER the last wanted frame — the start of
    // the NEXT edit unit — so [rangeStart, that-1] covers the wanted frames' whole edit units (video
    // + interleaved audio). This must NOT use the snapped resolver: when exact=false, snapping the
    // end frame back to its GOP-head keyframe collapses the range (e.g. frames 0..5 of a 12-frame GOP
    // → end snaps to frame 0 = rangeStart, yielding nothing). Always resolve the end exactly.
    const endFrame = startFrame + BigInt(frameCount);
    const resolvedEnd = resolveExactFrameOffset(segments, endFrame, essenceContainerStart, vid);

    // When the END frame isn't covered by the index (a partial / incremental / corrupt VBE index, or
    // a request that runs off the end of the indexed region) we don't know where the chunk stops.
    // Do NOT read from the start offset to EOF in one buffer — on a multi-GB file that allocates the
    // whole remainder. Instead walk bounded windows from the resolved start. `startEU` is the edit
    // unit at `resolved.byteOffset` (== startFrame for exact/CBG resolution, the snapped keyframe
    // otherwise), so the sequential reader numbers edit units consistently.
    if (!resolvedEnd) {
      const startEU = resolved.nearestKeyframeEditUnit;
      const seqCount = Math.max(frameCount, Number(endFrame - startEU));
      yield* this.fetchFramesSequential(startEU, seqCount, essenceContainerStart, resolved.byteOffset);
      return;
    }

    const rangeStart = Number(resolved.byteOffset);
    const rangeEnd = Number(resolvedEnd.byteOffset) - 1;

    if (rangeStart > rangeEnd) return;

    const kf = resolved.nearestKeyframeEditUnit;
    const reason = `essence frames ${startFrame}–${endFrame - 1n}` +
      (exact ? ' (exact)' : ` (snapped to keyframe ${kf})`);
    const chunkBuf = await this.loader.fetchRange(rangeStart, rangeEnd, reason, this.signal);
    yield* this.parseEssenceChunk(chunkBuf, startFrame, frameCount, rangeStart);
  }

  /**
   * No-index fallback: read the essence in bounded windows (no more than tens of MB resident),
   * parsing whole KLVs and carrying any incomplete trailing KLV into the next read, until
   * `frameCount` video frames have been emitted or EOF is reached. Replaces the old single
   * up-to-1.5 GB read, which could never complete on large or growing files.
   *
   * `fromByteOffset` lets a caller (e.g. a no-index percentage seek) start mid-file at a known
   * random-access byte; it defaults to the essence container start.
   */
  private async *fetchFramesSequential(
    startFrame: bigint,
    frameCount: number,
    essenceStart: bigint,
    fromByteOffset?: bigint
  ): AsyncGenerator<EssenceFrame> {
    const fileSize = await this.loader.fileSize;
    const state = { editUnit: startFrame, videoFramesSeen: 0, pendingSystemTc: null as Timecode | null };

    let window = SEQ_WINDOW;
    let carry: Uint8Array | null = null;
    let carryAbs = Number(fromByteOffset ?? essenceStart); // abs offset of carry[0]
    let fetchAbs = carryAbs;                                // next byte to fetch

    while (state.videoFramesSeen < frameCount) {
      const end = Math.min(fileSize - 1, fetchAbs + window - 1);
      if (fetchAbs > end) break; // EOF
      const fetched = new Uint8Array(
        await this.loader.fetchRange(fetchAbs, end, `essence sequential (no index) @${fetchAbs}`, this.signal)
      );
      const reachedEOF = end >= fileSize - 1;

      // Combine any carried (incomplete) trailing KLV with the freshly-read bytes. The result is
      // always a fresh, offset-0 buffer so KLVIterator/DataView can address it directly.
      let combined: Uint8Array;
      let combinedAbs: number;
      if (carry && carry.length > 0) {
        combined = new Uint8Array(carry.length + fetched.length);
        combined.set(carry, 0);
        combined.set(fetched, carry.length);
        combinedAbs = carryAbs;
      } else {
        combined = fetched;
        combinedAbs = fetchAbs;
      }

      // combined is always backed by a real (non-shared) ArrayBuffer at offset 0 (it's either the
      // fresh fetched buffer or a freshly-allocated concat), so this cast is safe.
      const stopOffset = yield* this.emitFromBuffer(combined.buffer as ArrayBuffer, 0, state, frameCount, combinedAbs);
      if (state.videoFramesSeen >= frameCount) break;
      if (reachedEOF) break; // nothing more to read; whatever's left is a trailing fragment

      if (stopOffset === 0) {
        // Not even one KLV fit in `combined` — a single edit unit exceeds the window. Read its
        // declared length exactly (key+BER are always present at this point) and fetch the rest.
        const dv = new DataView(combined.buffer);
        let fullKlvSize: number;
        try {
          const { length: vlen, bytesRead } = decodeBerLength(dv, 16);
          fullKlvSize = 16 + bytesRead + vlen;
        } catch { break; }
        if (fullKlvSize > SEQ_HARD_CAP) break; // implausible — bail rather than blow up memory
        carry = combined;
        carryAbs = combinedAbs;
        fetchAbs = combinedAbs + combined.length;
        window = Math.min(Math.max(window, fullKlvSize - combined.length + 16), SEQ_HARD_CAP);
        continue;
      }

      // Carry the incomplete trailing KLV (bytes from stopOffset to end) into the next read.
      // Copy (slice) rather than subarray so the large `combined` buffer can be freed immediately.
      carry = stopOffset < combined.length ? combined.slice(stopOffset) : null;
      carryAbs = combinedAbs + stopOffset;
      fetchAbs = combinedAbs + combined.length;
      window = SEQ_WINDOW; // reset after successful progress
    }
  }

  /** Index path: a single already-fetched chunk covers the requested range. */
  private async *parseEssenceChunk(
    buffer: ArrayBuffer,
    startFrame: bigint,
    frameCount: number,
    bufferAbs: number
  ): AsyncGenerator<EssenceFrame> {
    const state = { editUnit: startFrame, videoFramesSeen: 0, pendingSystemTc: null as Timecode | null };
    yield* this.emitFromBuffer(buffer, 0, state, frameCount, bufferAbs);
  }

  /**
   * Walk KLVs in `buffer` from `startOffset`, emitting video/audio EssenceFrames and updating
   * `state` (editUnit + videoFramesSeen) in place so the caller can resume across buffers. Returns
   * the byte offset where iteration stopped — the start of an incomplete trailing KLV, the start of
   * the first video frame past `frameCount`, or the end of the buffer. Skips partition packs and
   * KLV Fill (including the inter-frame fill used to pad CBG constant-size edit units).
   */
  private *emitFromBuffer(
    buffer: ArrayBuffer,
    startOffset: number,
    state: { editUnit: bigint; videoFramesSeen: number; pendingSystemTc: Timecode | null },
    frameCount: number,
    bufferAbs: number
  ): Generator<EssenceFrame, number> {
    const iter = new KLVIterator(buffer, startOffset);

    while (iter.hasMore()) {
      const pktStart = iter.offset;
      const pkt = iter.next();
      if (!pkt) return pktStart; // incomplete trailing KLV begins here

      if (isPartitionPack(pkt.key) || isFill(pkt.key)) continue;

      // System Item: carries this content package's per-frame timecode. It precedes the picture
      // element in the package, so stash the TC and attach it to the next emitted picture frame. A
      // package can have MORE than one system KLV (e.g. XAVC writes a System Metadata Pack that
      // carries the timecode PLUS a second pack that doesn't) — keep the first valid TC of the
      // package and don't let a later TC-less pack clobber it (pendingSystemTc is reset to null when
      // the picture frame consumes it, so the guard is per-package).
      if (isSystemItem(pkt.key)) {
        if (state.pendingSystemTc === null) {
          const sysVal = new Uint8Array(buffer, pkt.valueOffset, pkt.valueLength);
          state.pendingSystemTc = parseSystemItemTimecode(sysVal, this.tcBase);
        }
        continue;
      }

      const isVideo = isPictureEssence(pkt.key);
      const isAudio = isSoundEssence(pkt.key);
      if (!isVideo && !isAudio) continue;

      if (isVideo) {
        // Lock onto the first picture track number; skip picture elements from any other video track
        // so they neither emit nor advance the edit-unit counter (see videoTrackKey).
        if (this.videoTrackKey === null) {
          this.videoTrackKey = pkt.key.slice(12, 16);
        } else if (!trackKeyEquals(pkt.key, this.videoTrackKey)) {
          continue;
        }
        if (state.videoFramesSeen >= frameCount) return pktStart; // beyond the requested range
        if (state.videoFramesSeen > 0) state.editUnit++;
        state.videoFramesSeen++;
      }

      const data = buffer.slice(pkt.valueOffset, pkt.valueOffset + pkt.valueLength);

      // Hand the stashed system-item TC to this picture frame, then clear it so it can't leak onto
      // a later package's video element (audio elements don't consume it).
      const systemTimecode = isVideo ? (state.pendingSystemTc ?? undefined) : undefined;
      if (isVideo) state.pendingSystemTc = null;

      yield {
        trackType: isVideo ? 'video' : 'audio',
        editUnit: state.editUnit,
        pts: state.editUnit,
        dts: state.editUnit,
        isKeyframe: isVideo, // refined via index flags at seek time
        data,
        systemTimecode,
        aes3: !isVideo && isAes3Sound(pkt.key),
        byteOffset: BigInt(bufferAbs + pktStart),
      };
    }

    return iter.offset;
  }
}

/** Compare an essence element key's track-number bytes (key[12..15]) against a 4-byte lock. */
function trackKeyEquals(key: Uint8Array, track4: Uint8Array): boolean {
  return key[12] === track4[0] && key[13] === track4[1] &&
         key[14] === track4[2] && key[15] === track4[3];
}
