import { ILoader } from '../loader/loader.js';
import { MxfBootstrap } from '../mxf-file.js';
import { KLVIterator } from '../core/klv.js';
import { isPictureEssence, isSoundEssence, isPartitionPack, isFill } from '../core/ul.js';
import { resolveFrameOffset, resolveExactFrameOffset, IndexTableSegment } from '../parser/index-table.js';

export interface EssenceFrame {
  trackType: 'video' | 'audio';
  editUnit: bigint;
  /** Presentation timestamp in edit units */
  pts: bigint;
  /** Decode timestamp in edit units */
  dts: bigint;
  isKeyframe: boolean;
  data: ArrayBuffer;
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
    const { indexSegments, essenceStart } = this.bootstrap;

    if (indexSegments.length > 0) {
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
    const resolved = resolve(segments, startFrame, essenceContainerStart);
    if (!resolved) return;

    // Determine end byte: resolve the frame AFTER the last wanted frame.
    // Add a 512 KB pad to capture trailing audio KLVs for the last video frame.
    const endFrame = startFrame + BigInt(frameCount);
    const resolvedEnd = resolve(segments, endFrame, essenceContainerStart);
    const fileSize = await this.loader.fileSize;

    const rangeStart = Number(resolved.byteOffset);
    const rangeEnd = resolvedEnd
      ? Math.min(Number(resolvedEnd.byteOffset) + 512 * 1024, fileSize) - 1
      : fileSize - 1;

    if (rangeStart > rangeEnd) return;

    const kf = resolved.nearestKeyframeEditUnit;
    const reason = `essence frames ${startFrame}–${endFrame - 1n}` +
      (exact ? ' (exact)' : ` (snapped to keyframe ${kf})`);
    const chunkBuf = await this.loader.fetchRange(rangeStart, rangeEnd, reason);
    yield* this.parseEssenceChunk(chunkBuf, startFrame, frameCount);
  }

  private async *fetchFramesSequential(
    startFrame: bigint,
    frameCount: number,
    essenceStart: bigint
  ): AsyncGenerator<EssenceFrame> {
    const fileSize = await this.loader.fileSize;
    const rangeStart = Number(essenceStart);
    // Cap at 1.5 GB to stay under V8's 2 GB ArrayBuffer limit.
    // Files that need sequential access beyond 1.5 GB require an index table.
    const MAX_SEQUENTIAL_BYTES = 1.5 * 1024 * 1024 * 1024;
    const rangeEnd = Math.min(fileSize - 1, rangeStart + MAX_SEQUENTIAL_BYTES - 1);
    const chunkBuf = await this.loader.fetchRange(rangeStart, rangeEnd, `essence sequential from frame ${startFrame} (no index)`);
    yield* this.parseEssenceChunk(chunkBuf, startFrame, frameCount);
  }

  private async *parseEssenceChunk(
    buffer: ArrayBuffer,
    startFrame: bigint,
    frameCount: number
  ): AsyncGenerator<EssenceFrame> {
    const iter = new KLVIterator(buffer, 0);
    let editUnit = startFrame;
    let videoFramesSeen = 0;

    while (iter.hasMore()) {
      const pkt = iter.next();
      if (!pkt) break;

      if (isPartitionPack(pkt.key) || isFill(pkt.key)) continue;

      const isVideo = isPictureEssence(pkt.key);
      const isAudio = isSoundEssence(pkt.key);

      if (!isVideo && !isAudio) continue;

      if (isVideo) {
        if (videoFramesSeen >= frameCount) break;
        if (videoFramesSeen > 0) editUnit++;
        videoFramesSeen++;
      }

      const data = buffer.slice(pkt.valueOffset, pkt.valueOffset + pkt.valueLength);

      yield {
        trackType: isVideo ? 'video' : 'audio',
        editUnit,
        pts: editUnit,
        dts: editUnit,
        isKeyframe: isVideo, // refined via index flags at seek time
        data,
      };
    }
  }
}
