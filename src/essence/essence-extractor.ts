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
   *
   * A holder (not a bare field) so the shared {@link emitEssenceFrames} walk can lock it across calls.
   */
  private readonly videoTrackKey: VideoTrackKeyHolder = { key: null };
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
    const state: WalkState = { editUnit: startFrame, videoFramesSeen: 0, started: false, pendingSystemTc: null };

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
      const stopOffset = yield* emitEssenceFrames(combined.buffer as ArrayBuffer, 0, state, frameCount, combinedAbs, this.walkCtx);
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
    const state: WalkState = { editUnit: startFrame, videoFramesSeen: 0, started: false, pendingSystemTc: null };
    yield* emitEssenceFrames(buffer, 0, state, frameCount, bufferAbs, this.walkCtx);
  }

  /** Context the shared KLV walk needs: the cross-call video-track lock and the timecode base. */
  private get walkCtx(): WalkCtx {
    return { videoTrackKey: this.videoTrackKey, tcBase: this.tcBase };
  }
}

/** Mutable holder for the locked video track number, shared by the walk across calls. */
interface VideoTrackKeyHolder { key: Uint8Array | null }

/** Per-walk context: the (cross-call) video-track lock and the rounded timecode base. */
interface WalkCtx { videoTrackKey: VideoTrackKeyHolder; tcBase: number }

/**
 * Persistent state for {@link emitEssenceFrames}, threaded across buffers (windowed reads) and, in
 * live mode, across many separate forward reads. `started` is true once any video frame has been
 * emitted, so the edit-unit counter advances on every subsequent picture element (not the first) —
 * which keeps numbering continuous across reads without re-emitting the last frame's edit unit.
 */
export interface WalkState {
  editUnit: bigint;
  videoFramesSeen: number;
  started: boolean;
  pendingSystemTc: Timecode | null;
}

/**
 * Walk KLVs in `buffer` from `startOffset`, emitting video/audio EssenceFrames and updating `state`
 * in place so a caller can resume across buffers. Returns the byte offset where iteration stopped —
 * the start of an incomplete trailing KLV, the start of the first video frame past `frameCount`, or
 * the end of the buffer. Skips partition packs and KLV Fill (incl. the inter-frame fill that pads
 * CBG constant-size edit units). Shared by the sequential reader, the index chunk parser, and the
 * live forward reader.
 */
export function* emitEssenceFrames(
  buffer: ArrayBuffer,
  startOffset: number,
  state: WalkState,
  frameCount: number,
  bufferAbs: number,
  ctx: WalkCtx,
): Generator<EssenceFrame, number> {
  const iter = new KLVIterator(buffer, startOffset);

  while (iter.hasMore()) {
    const pktStart = iter.offset;
    const pkt = iter.next();
    if (!pkt) return pktStart; // incomplete trailing KLV begins here
    // Stop at the first byte that isn't a valid MXF key (06 0e 2b 34). In a growing/preallocated
    // recording this is the unwritten zero frontier: returning its offset lets the live reader treat
    // it as the edge and wait, instead of walking zero-padding as bogus KLVs and desyncing.
    if (pkt.key[0] !== 0x06 || pkt.key[1] !== 0x0e || pkt.key[2] !== 0x2b || pkt.key[3] !== 0x34) return pktStart;

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
        state.pendingSystemTc = parseSystemItemTimecode(sysVal, ctx.tcBase);
      }
      continue;
    }

    const isVideo = isPictureEssence(pkt.key);
    const isAudio = isSoundEssence(pkt.key);
    if (!isVideo && !isAudio) continue;

    if (isVideo) {
      // Lock onto the first picture track number; skip picture elements from any other video track
      // so they neither emit nor advance the edit-unit counter (see videoTrackKey).
      if (ctx.videoTrackKey.key === null) {
        ctx.videoTrackKey.key = pkt.key.slice(12, 16);
      } else if (!trackKeyEquals(pkt.key, ctx.videoTrackKey.key)) {
        continue;
      }
      if (state.videoFramesSeen >= frameCount) return pktStart; // beyond the requested range
      // Advance on every picture element except the very first one emitted (across all reads), so
      // audio in the same package shares the package's edit unit and numbering stays continuous.
      if (state.started) state.editUnit++;
      state.started = true;
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

/** Compare an essence element key's track-number bytes (key[12..15]) against a 4-byte lock. */
function trackKeyEquals(key: Uint8Array, track4: Uint8Array): boolean {
  return key[12] === track4[0] && key[13] === track4[1] &&
         key[14] === track4[2] && key[15] === track4[3];
}

/**
 * Live-mode forward reader for a growing recording. Holds a persistent byte cursor, carry (the
 * incomplete trailing KLV at the file's edge), and a CONTINUOUS edit-unit counter, so successive
 * {@link readForward} calls stream frames straight forward — and the edit unit keeps climbing across
 * the whole session (including across rotated files when seeded via `startEditUnit`), which is what
 * makes the fragmenter's timestamps continuous for seamless stitching. Reuses {@link emitEssenceFrames}
 * for KLV classification; the only extra logic is the persistent windowed read with carry, bounded by
 * the CURRENT (polled) file size rather than the one-shot `loader.fileSize`.
 */
export class LiveSequentialReader {
  private readonly loader: ILoader;
  private readonly tcBase: number;
  private readonly videoTrackKey: VideoTrackKeyHolder = { key: null };
  private readonly state: WalkState;
  private carry: Uint8Array | null = null;
  private carryAbs: number;
  private fetchAbs: number;
  /** True when the last readForward stopped because it reached the current file size (live edge). */
  private _atEdge = false;

  constructor(loader: ILoader, startByteOffset: bigint, startEditUnit: bigint, tcBase: number) {
    this.loader = loader;
    this.tcBase = tcBase;
    this.fetchAbs = Number(startByteOffset);
    this.carryAbs = this.fetchAbs;
    this.state = { editUnit: startEditUnit, videoFramesSeen: 0, started: false, pendingSystemTc: null };
  }

  /** Caught up to EOF as of the last read (no more complete frames available right now). */
  get atEdge(): boolean { return this._atEdge; }
  /** Absolute byte offset of the next unread byte (the live edge cursor). */
  get cursor(): number { return this.fetchAbs; }
  /** Edit unit that the NEXT emitted video frame will carry (continuous across reads). */
  get nextEditUnit(): bigint { return this.state.started ? this.state.editUnit + 1n : this.state.editUnit; }

  /**
   * Read forward up to `frameCount` video frames, bounded by `currentFileSize` (the latest polled
   * size). Persists cursor/carry/edit-unit so the next call resumes exactly where this stopped.
   * Stops early (retaining carry) when it reaches the current edge — the caller then polls and calls
   * again once the file has grown.
   */
  async *readForward(frameCount: number, currentFileSize: number, signal?: AbortSignal): AsyncGenerator<EssenceFrame> {
    const ctx: WalkCtx = { videoTrackKey: this.videoTrackKey, tcBase: this.tcBase };
    this.state.videoFramesSeen = 0; // per-call budget; editUnit/started persist
    this._atEdge = false;
    let window = SEQ_WINDOW;

    while (this.state.videoFramesSeen < frameCount) {
      const end = Math.min(currentFileSize - 1, this.fetchAbs + window - 1);
      if (this.fetchAbs > end) { this._atEdge = true; break; } // at the live edge — nothing new yet

      const fetched = new Uint8Array(
        await this.loader.fetchRange(this.fetchAbs, end, `live forward @${this.fetchAbs}`, signal)
      );
      const reachedEdge = end >= currentFileSize - 1;

      let combined: Uint8Array;
      let combinedAbs: number;
      if (this.carry && this.carry.length > 0) {
        combined = new Uint8Array(this.carry.length + fetched.length);
        combined.set(this.carry, 0);
        combined.set(fetched, this.carry.length);
        combinedAbs = this.carryAbs;
      } else {
        combined = fetched;
        combinedAbs = this.fetchAbs;
      }

      const stopOffset = yield* emitEssenceFrames(combined.buffer as ArrayBuffer, 0, this.state, frameCount, combinedAbs, ctx);

      // Unwritten frontier: the walk stopped on bytes that aren't a valid MXF key. The recorder
      // preallocates the file ahead of the data it has written, so the reported size covers
      // zero-padding past the live write-frontier — this is the edge, NOT corruption. Drop the zero
      // carry and reset the cursor to the frontier so the next read re-fetches it fresh once the real
      // bytes land. Without this the walk would parse zero-padding as bogus KLVs and desync.
      if (stopOffset < combined.length &&
          !(combined[stopOffset] === 0x06 && combined[stopOffset + 1] === 0x0e &&
            combined[stopOffset + 2] === 0x2b && combined[stopOffset + 3] === 0x34)) {
        this.carry = null;
        this.carryAbs = combinedAbs + stopOffset;
        this.fetchAbs = combinedAbs + stopOffset;
        this._atEdge = true;
        break;
      }

      // Oversized single KLV (a frame larger than the window) — read its declared length exactly and
      // retry, unless implausibly large.
      if (stopOffset === 0 && this.state.videoFramesSeen < frameCount && !reachedEdge) {
        const dv = new DataView(combined.buffer);
        let fullKlvSize: number;
        try { const { length: vlen, bytesRead } = decodeBerLength(dv, 16); fullKlvSize = 16 + bytesRead + vlen; }
        catch { this._atEdge = true; break; }
        if (fullKlvSize > SEQ_HARD_CAP) { this._atEdge = true; break; }
        this.carry = combined;
        this.carryAbs = combinedAbs;
        this.fetchAbs = combinedAbs + combined.length;
        window = Math.min(Math.max(window, fullKlvSize - combined.length + 16), SEQ_HARD_CAP);
        continue;
      }

      // Carry the incomplete trailing KLV (or the over-budget frame's bytes) into the next call.
      this.carry = stopOffset < combined.length ? combined.slice(stopOffset) : null;
      this.carryAbs = combinedAbs + stopOffset;
      this.fetchAbs = combinedAbs + combined.length;
      window = SEQ_WINDOW;

      if (reachedEdge && this.state.videoFramesSeen < frameCount) { this._atEdge = true; break; }
    }
  }
}
