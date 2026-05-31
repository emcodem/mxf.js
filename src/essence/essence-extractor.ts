import { ILoader } from '../loader/loader.js';
import { MxfBootstrap } from '../mxf-file.js';
import { KLVIterator } from '../core/klv.js';
import { decodeBerLength } from '../core/ber.js';
import { isPictureEssence, isSoundEssence, isAes3Sound, isPartitionPack, isFill } from '../core/ul.js';
import { resolveFrameOffset, resolveExactFrameOffset, IndexTableSegment } from '../parser/index-table.js';

/** Base read window for the no-index sequential reader. */
const SEQ_WINDOW = 4 * 1024 * 1024;
/** Hard cap on a single edit unit / accumulated buffer — guards against a corrupt BER length. */
const SEQ_HARD_CAP = 64 * 1024 * 1024;

export interface EssenceFrame {
  trackType: 'video' | 'audio';
  editUnit: bigint;
  /** Presentation timestamp in edit units */
  pts: bigint;
  /** Decode timestamp in edit units */
  dts: bigint;
  isKeyframe: boolean;
  data: ArrayBuffer;
  /** Audio only: true when the sound element is AES3-wrapped (SMPTE 331M / D-10) rather than plain PCM. */
  aes3?: boolean;
}

export class EssenceExtractor {
  private readonly loader: ILoader;
  private readonly bootstrap: MxfBootstrap;

  constructor(loader: ILoader, bootstrap: MxfBootstrap) {
    this.loader = loader;
    this.bootstrap = bootstrap;
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
  async *fetchFrames(startFrame: bigint, frameCount: number, exact = false): AsyncGenerator<EssenceFrame> {
    const { indexSegments, essenceStart, indexMode } = this.bootstrap;

    // 'none' (no usable index — e.g. growing/live files) always scans sequentially, even if a
    // stray/partial index segment exists, since it can't be trusted to map frames to offsets.
    if (indexMode !== 'none' && indexSegments.length > 0) {
      yield* this.fetchFramesViaIndex(startFrame, frameCount, indexSegments, essenceStart, exact);
    } else {
      yield* this.fetchFramesSequential(startFrame, frameCount, essenceStart);
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

    // Determine end byte: resolve the frame AFTER the last wanted frame. Its offset is the start of
    // the NEXT edit unit, so [rangeStart, that-1] already covers the wanted frames' whole edit units
    // (video + their interleaved audio) — no read-ahead pad. (The old +512 KB pad made every
    // consecutive chunk overlap the next by 512 KB, re-downloading data we'd already fetched.)
    const endFrame = startFrame + BigInt(frameCount);
    const resolvedEnd = resolve(segments, endFrame, essenceContainerStart, vid);
    const fileSize = await this.loader.fileSize;

    const rangeStart = Number(resolved.byteOffset);
    const rangeEnd = resolvedEnd
      ? Number(resolvedEnd.byteOffset) - 1
      : fileSize - 1;

    if (rangeStart > rangeEnd) return;

    const kf = resolved.nearestKeyframeEditUnit;
    const reason = `essence frames ${startFrame}–${endFrame - 1n}` +
      (exact ? ' (exact)' : ` (snapped to keyframe ${kf})`);
    const chunkBuf = await this.loader.fetchRange(rangeStart, rangeEnd, reason);
    yield* this.parseEssenceChunk(chunkBuf, startFrame, frameCount);
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
    const state = { editUnit: startFrame, videoFramesSeen: 0 };

    let window = SEQ_WINDOW;
    let carry: Uint8Array | null = null;
    let carryAbs = Number(fromByteOffset ?? essenceStart); // abs offset of carry[0]
    let fetchAbs = carryAbs;                                // next byte to fetch

    while (state.videoFramesSeen < frameCount) {
      const end = Math.min(fileSize - 1, fetchAbs + window - 1);
      if (fetchAbs > end) break; // EOF
      const fetched = new Uint8Array(
        await this.loader.fetchRange(fetchAbs, end, `essence sequential (no index) @${fetchAbs}`)
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
      const stopOffset = yield* this.emitFromBuffer(combined.buffer as ArrayBuffer, 0, state, frameCount);
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
    frameCount: number
  ): AsyncGenerator<EssenceFrame> {
    const state = { editUnit: startFrame, videoFramesSeen: 0 };
    yield* this.emitFromBuffer(buffer, 0, state, frameCount);
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
    state: { editUnit: bigint; videoFramesSeen: number },
    frameCount: number
  ): Generator<EssenceFrame, number> {
    const iter = new KLVIterator(buffer, startOffset);

    while (iter.hasMore()) {
      const pktStart = iter.offset;
      const pkt = iter.next();
      if (!pkt) return pktStart; // incomplete trailing KLV begins here

      if (isPartitionPack(pkt.key) || isFill(pkt.key)) continue;

      const isVideo = isPictureEssence(pkt.key);
      const isAudio = isSoundEssence(pkt.key);
      if (!isVideo && !isAudio) continue;

      if (isVideo) {
        if (state.videoFramesSeen >= frameCount) return pktStart; // beyond the requested range
        if (state.videoFramesSeen > 0) state.editUnit++;
        state.videoFramesSeen++;
      }

      const data = buffer.slice(pkt.valueOffset, pkt.valueOffset + pkt.valueLength);

      yield {
        trackType: isVideo ? 'video' : 'audio',
        editUnit: state.editUnit,
        pts: state.editUnit,
        dts: state.editUnit,
        isKeyframe: isVideo, // refined via index flags at seek time
        data,
        aes3: !isVideo && isAes3Sound(pkt.key),
      };
    }

    return iter.offset;
  }
}
