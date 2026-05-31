import { HttpLoader } from '../loader/http-loader.js';
import { FileLoader } from '../loader/file-loader.js';
import { ILoader } from '../loader/loader.js';
import { MxfFile } from '../mxf-file.js';
import { EssenceExtractor } from '../essence/essence-extractor.js';
import { Mp4Fragmenter } from '../remuxer/mp4-fragmenter.js';
import { resolveFrameOffset, gopLengthFromKeyframe } from '../parser/index-table.js';
import { isAnnexB, annexBtoAVCC, extractSPSPPS, buildAVCDecoderConfigRecord } from '../essence/avc-tools.js';
import { decodePcmElements } from '../audio/pcm.js';
import { WorkerCommand, WorkerEvent } from './worker-messages.js';
import type { EssenceFrame } from '../essence/essence-extractor.js';
import { ScrubSegmentCache } from './scrub-segment-cache.js';
import { FetchQueue } from './fetch-queue.js';
import { Mpeg2Pipeline } from './mpeg2-pipeline.js';
import {
  SCRUB_PREVIEW_LOOKAHEAD_SECONDS,
  SCRUB_PREVIEW_MIN_LOOKAHEAD_FRAMES,
} from '../core/constants.js';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
declare const self: WorkerScope;

let loader: ILoader | null = null;
let mxfFile: MxfFile | null = null;
let fragmenter: Mp4Fragmenter | null = null;
let videoMode: 'webcodecs' | 'mse' = 'mse';
let storedEditRateNumerator = 25;
let storedEditRateDenominator = 1;
// Gates the worker's informational/trace logs (set from cmd.debug in handleInit). Error logs
// are unconditional; these are progress/diagnostic lines that would otherwise spam every consumer.
let workerDebug = false;

// MPEG-2 → H.264 transcode pipeline (null when source is not MPEG-2). Owns the persistent
// decoder + encoder, the display-order edit-unit counter, and the held-anchor decode loop.
let mpeg2Pipeline: Mpeg2Pipeline | null = null;

// Serializes fetches (one at a time) and lets a seek discard superseded work — see FetchQueue.
// run executes one job by delegating to handleFetchSegment (hoisted, so referencing it here is fine).
const fetchQ = new FetchQueue((job) =>
  handleFetchSegment(job.startFrame, job.frameCount, job.seqBase, job.gen, job.stretchToFrames, job.previewSeq),
);
// seqBase pool for internally-scheduled scrub-preview decodes (kept apart from the player's seqBase).
let scrubSeqBase = 1_000_000;

// Scrub-preview cache (GOP-head keyframe edit unit → encoded fMP4 video segment); see
// ScrubSegmentCache for why this is what makes MPEG-2 scrubbing usable. Cleared on each file load.
const scrubSegmentCache = new ScrubSegmentCache();

function post(event: WorkerEvent, transferables: Transferable[] = []): void {
  self.postMessage(event, transferables);
}

function postError(message: string, fatal = false): void {
  post({ type: 'error', message, fatal });
}

async function handleInit(loader_: ILoader, debug = false): Promise<void> {
  loader = loader_;
  workerDebug = debug;
  mxfFile = new MxfFile(loader, debug);
  mpeg2Pipeline = null;
  scrubSegmentCache.clear();

  try {
    const bootstrap = await mxfFile.open();
    const { metadata } = bootstrap;
    fragmenter = new Mp4Fragmenter(metadata);
    const pd = metadata.pictureDescriptor;
    const sd = metadata.soundDescriptor;
    storedEditRateNumerator = metadata.editRateNumerator;
    storedEditRateDenominator = metadata.editRateDenominator;

    // Decode the first edit unit's audio up front to learn the true PCM channel count (separate-mono
    // and AES3 layouts can differ from the descriptor's channelCount). Surfaced in the manifest so
    // the UI can build a channel selector immediately, not only once audio starts playing.
    let audioChannelCount = 0;
    if (sd?.codec === 'pcm') {
      try {
        const aex = new EssenceExtractor(loader_, bootstrap);
        const aud: { editUnit: bigint; data: ArrayBuffer; aes3?: boolean }[] = [];
        for await (const f of aex.fetchFrames(0n, 2)) {
          if (f.trackType === 'audio') aud.push({ editUnit: f.editUnit, data: f.data, aes3: f.aes3 });
        }
        if (aud.length) {
          audioChannelCount = decodePcmElements(
            aud, { bitDepth: sd.bitDepth, blockAlign: sd.blockAlign, channelCount: sd.channelCount },
          ).channelCount;
        }
      } catch { /* refined later from pcmSamples if this fails */ }
    }

    const durationSec = pd
      ? Number(metadata.duration) * (metadata.editRateDenominator / metadata.editRateNumerator)
      : 0;

    // -----------------------------------------------------------------------
    // MPEG-2 path: transcode to H.264 so MSE / native video element can play
    // -----------------------------------------------------------------------
    if (pd?.codec === 'mpeg2') {
      const extractor = new EssenceExtractor(loader_, bootstrap);
      let firstVideoFrame: EssenceFrame | null = null;
      // Fetch up to 50 frames — in OP1a interleaved files audio frames may
      // precede video frames within the same edit unit batch.
      for await (const frame of extractor.fetchFrames(0n, 50)) {
        if (frame.trackType === 'video') { firstVideoFrame = frame; break; }
      }
      if (!firstVideoFrame) {
        postError('MPEG-2: no video frames found in first 50 edit units', true);
        return;
      }

      // Probe-decode the first frame for coded dimensions + chroma, then build the transcode
      // pipeline (encoder → SPS/PPS → persistent stream decoder). See Mpeg2Pipeline.
      const probe = Mpeg2Pipeline.probeFirstFrame(firstVideoFrame.data);
      if (!probe) {
        postError('MPEG-2: failed to decode first frame', true);
        return;
      }
      const pipeline = await Mpeg2Pipeline.create(probe, storedEditRateNumerator, storedEditRateDenominator);
      if (!pipeline) {
        postError('MPEG-2: VideoEncoder did not produce SPS/PPS', true);
        return;
      }
      mpeg2Pipeline = pipeline;

      // Use coded (MB-aligned) dimensions for the avc1 box. Chrome's WebCodecs VideoEncoder does not
      // insert frame_cropping_flag in the SPS even when displayHeight < codedHeight (e.g. 1080 vs
      // 1088); declaring 1080 in the avc1 box while the SPS says "display = coded = 1088" makes
      // Chrome's MSE parser flag a mismatch and fire a SourceBuffer error. codedHeight keeps the
      // container consistent with the SPS.
      fragmenter!.enableTranscodeMode(pipeline.sps, pipeline.pps, pipeline.codedWidth, pipeline.codedHeight);

      // PCM audio uses Web Audio — skip audio track from moov entirely. Chrome MSE rejects init
      // segments containing unknown codec sample entries (sowt) even in a video-only SourceBuffer.
      const initSeg = fragmenter!.buildInitSegment(false);
      if (workerDebug) console.log('[worker] MPEG-2 transcode init OK',
        'sps:', Array.from(pipeline.sps).map(b=>b.toString(16).padStart(2,'0')).join(' '),
        'pps:', Array.from(pipeline.pps).map(b=>b.toString(16).padStart(2,'0')).join(' '),
        `dims: ${pipeline.displayWidth}x${pipeline.displayHeight} (coded: ${pipeline.codedWidth}x${pipeline.codedHeight})`,
        'initSeg bytes:', initSeg.length,
      );

      post({
        type: 'manifest',
        duration: durationSec,
        editRateNumerator: storedEditRateNumerator,
        editRateDenominator: storedEditRateDenominator,
        tracks: metadata.packages.flatMap(p => p.tracks),
        pictureDescriptor: pd,
        soundDescriptor: sd,
        videoCodecSupported: true,
        pcmMseSupported: false,
        // Codec string from the actual SPS bytes so it matches the constraint byte in the avcC box
        // (decoderConfig.codec may report constraints=0x00 while the SPS has e.g. 0x4c — that
        // mismatch causes a SourceBuffer error when Chrome checks MIME vs avcC on init append).
        resolvedVideoCodec: pipeline.codecString,
        resolvedVideoMode: 'mse',
        indexMode: bootstrap.indexMode,
        audioChannelCount,
      });

      const initBuf = initSeg.buffer.slice(initSeg.byteOffset, initSeg.byteOffset + initSeg.byteLength) as ArrayBuffer;
      post({ type: 'initSegment', data: initBuf }, [initBuf]);
      return;
    }

    // -----------------------------------------------------------------------
    // H.264 path: pre-fetch first frame to get SPS/PPS
    // -----------------------------------------------------------------------
    let videoCodecSupported = true;
    let pendingVideoInit: { codec: string; description: Uint8Array; width: number; height: number } | null = null;

    if (pd?.codec === 'h264') {
      try {
        const extractor = new EssenceExtractor(loader_, bootstrap);
        for await (const frame of extractor.fetchFrames(0n, 1)) {
          if (frame.trackType !== 'video') continue;
          const avccData = isAnnexB(frame.data) ? annexBtoAVCC(frame.data) : frame.data;
          const { sps, pps } = extractSPSPPS(avccData);
          if (sps.length > 0 && pps.length > 0) {
            fragmenter!.setSPSPPS(sps[0], pps[0]);
            if (videoMode === 'webcodecs') {
              const desc = buildAVCDecoderConfigRecord(sps[0], pps[0]);
              const p = sps[0][1], c = sps[0][2], l = sps[0][3];
              const codec = `avc1.${p.toString(16).padStart(2,'0')}${c.toString(16).padStart(2,'0')}${l.toString(16).padStart(2,'0')}`;
              pendingVideoInit = { codec, description: desc, width: pd.width, height: pd.height };
            }
          }
          break;
        }
      } catch (e) {
        console.error('[worker] H.264 pre-fetch failed:', e);
      }
    }

    const resolvedMode: 'mse' | 'webcodecs' =
      (videoMode === 'webcodecs' && pendingVideoInit) ? 'webcodecs' : 'mse';

    post({
      type: 'manifest',
      duration: durationSec,
      editRateNumerator: storedEditRateNumerator,
      editRateDenominator: storedEditRateDenominator,
      tracks: metadata.packages.flatMap(p => p.tracks),
      pictureDescriptor: pd,
      soundDescriptor: sd,
      videoCodecSupported,
      pcmMseSupported: false,
      resolvedVideoCodec: pd?.codec ?? 'unknown',
      resolvedVideoMode: resolvedMode,
      indexMode: bootstrap.indexMode,
      audioChannelCount,
    });

    if (resolvedMode === 'webcodecs' && pendingVideoInit) {
      const { codec, description, width, height } = pendingVideoInit;
      const descBuf = description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength) as ArrayBuffer;
      post({ type: 'videoInit', codec, description: descBuf, width, height }, [descBuf]);
    } else {
      const includeAudio = sd?.codec !== 'pcm'; // PCM uses Web Audio — skip from moov
      const initSeg = fragmenter!.buildInitSegment(includeAudio);
      const initBuf = initSeg.buffer.slice(initSeg.byteOffset, initSeg.byteOffset + initSeg.byteLength) as ArrayBuffer;
      post({ type: 'initSegment', data: initBuf }, [initBuf]);
    }

  } catch (e) {
    postError(`Failed to parse MXF: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function handleFetchSegment(
  startFrame: number,
  frameCount: number,
  seqBase: number,
  gen: number,
  stretchToFrames = 0,
  previewSeq?: number,
): Promise<void> {
  // A scrub preview is a throwaway single-frame decode that must always answer with previewDone
  // (so the player's single-flight pump never deadlocks) and must skip audio.
  const isScrubPreview = previewSeq !== undefined;
  if (!loader || !mxfFile || !fragmenter) {
    postError('Not initialized');
    if (isScrubPreview) post({ type: 'previewDone', seq: previewSeq!, editUnit: startFrame });
    return;
  }
  const bootstrap = mxfFile.getBootstrap();
  if (!bootstrap) {
    postError('Bootstrap not complete');
    if (isScrubPreview) post({ type: 'previewDone', seq: previewSeq!, editUnit: startFrame });
    return;
  }

  try {
    const extractor = new EssenceExtractor(loader, bootstrap);
    const frames: EssenceFrame[] = [];
    // The MPEG-2 transcode path feeds one persistent decoder, so it needs the exact
    // consecutive frame range (no keyframe snapping) to avoid re-feeding pictures it has
    // already decoded. Seeks land on a keyframe anyway, where exact and snapped agree.
    const exact = !!mpeg2Pipeline;
    for await (const frame of extractor.fetchFrames(BigInt(startFrame), frameCount, exact)) {
      frames.push(frame);
    }

    // A seek arrived while we were reading bytes: the decoder has been reset to a new
    // position, so feeding it these (now stale) frames would corrupt the post-seek decode.
    // Drop this fetch entirely; the player issues a fresh fetch after the 'seeked' event.
    if (gen !== fetchQ.currentGeneration) return;

    const videoFrames = frames.filter(f => f.trackType === 'video');
    const audioFrames = frames.filter(f => f.trackType === 'audio');

    // -----------------------------------------------------------------------
    // MPEG-2 → H.264 transcode
    // -----------------------------------------------------------------------
    if (mpeg2Pipeline) {
      if (videoFrames.length > 0) {
        const pipeline = mpeg2Pipeline;

        // The decoder holds its final I/P anchor back for display reordering. During normal playback
        // keep it held so the next segment emits it in order; flush it only at end-of-stream (fewer
        // frames returned than requested), for a keyframe-only preview (a single intra picture that
        // would otherwise stay held), or for a throwaway scrub preview (no next segment picks it up).
        const keyframePreview = stretchToFrames > 0;
        const atEndOfStream = videoFrames.length < frameCount;
        const flushHeldAnchor = atEndOfStream || keyframePreview || isScrubPreview;

        // The decode loop bails the moment a seek/scrub supersedes this fetch (otherwise a scrub
        // preview can't start until the whole in-flight chunk finishes); flush() still runs so the
        // shared encoder queue is drained clean — but if superseded we drop the chunks below.
        const { chunks, framesEmitted, decodeMs, encodeMs } = await pipeline.decodeSegment(
          videoFrames, flushHeldAnchor, () => gen !== fetchQ.currentGeneration,
        );
        if (gen !== fetchQ.currentGeneration) return;

        const n = Math.max(1, framesEmitted);
        if (workerDebug) console.log(
          `[transcode] startFrame=${startFrame}: ${videoFrames.length} ES frames → ${framesEmitted} frames | ` +
          `decode+prep ${decodeMs.toFixed(0)} ms (${(decodeMs / n).toFixed(1)} ms/f) | ` +
          `encode drain ${encodeMs.toFixed(0)} ms (${(encodeMs / n).toFixed(1)} ms/f) | ` +
          `total ${(decodeMs + encodeMs).toFixed(0)} ms`,
        );

        const seg = fragmenter.buildTranscodedVideoSegment(
          chunks,
          keyframePreview ? { totalDurationFrames: stretchToFrames } : undefined,
        );
        if (seg && isScrubPreview) {
          // Cache a copy keyed by the GOP-head keyframe (= startFrame here) so future scrub
          // visits to this GOP skip the decode/encode entirely (see scrubSegmentCache).
          scrubSegmentCache.set(startFrame, seg.slice());
        }
        if (seg) {
          if (workerDebug) console.log('[worker] videoSegment', seg.length, 'bytes,', chunks.length, 'chunks, first chunk keyframe:', chunks[0]?.isKeyframe, 'first chunk editUnit:', chunks[0] ? Number(chunks[0].editUnit) : -1, keyframePreview ? `(keyframe preview, stretch ${stretchToFrames}f)` : '');
          post(
            { type: 'videoSegment', data: seg.buffer as ArrayBuffer, seq: seqBase, editUnit: startFrame },
            [seg.buffer],
          );
        }
      }
    } else {
      // -----------------------------------------------------------------------
      // H.264 / WebCodecs path (unchanged)
      // -----------------------------------------------------------------------
      if (videoFrames.length > 0) {
        if (videoMode === 'webcodecs') {
          const frameDurationUs = Math.round(storedEditRateDenominator * 1_000_000 / storedEditRateNumerator);
          for (const frame of videoFrames) {
            const avccBuf: ArrayBuffer = isAnnexB(frame.data)
              ? annexBtoAVCC(frame.data)
              : (frame.data as ArrayBuffer).slice(0);
            const tsUs = Math.round(Number(frame.editUnit) * storedEditRateDenominator * 1_000_000 / storedEditRateNumerator);
            post(
              { type: 'videoChunk', data: avccBuf, timestamp: tsUs, duration: frameDurationUs, keyframe: frame.isKeyframe },
              [avccBuf],
            );
          }
        } else {
          const seg = fragmenter.buildVideoSegment(videoFrames);
          if (seg) {
            if (isScrubPreview) {
              // Cache the (all-intra) preview segment so revisiting this frame avoids the disk read
              // + remux. Keyed by startFrame (= the requested keyframe). See scrubSegmentCache.
              scrubSegmentCache.set(startFrame, seg.slice());
            }
            post(
              { type: 'videoSegment', data: seg.buffer as ArrayBuffer, seq: seqBase, editUnit: startFrame },
              [seg.buffer],
            );
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Audio (skipped for throwaway scrub previews — video-only)
    // -----------------------------------------------------------------------
    if (!isScrubPreview && audioFrames.length > 0) {
      const sd = bootstrap.metadata.soundDescriptor;
      if (sd?.codec === 'pcm') {
        // MXF PCM is little-endian signed at the descriptor's bit depth (24-bit for these
        // files, not 16). Channels arrive either as one interleaved element or as N separate
        // mono elements per edit unit; decodePcmElements handles both → interleaved Float32.
        const { samples: float32, channelCount } = decodePcmElements(
          audioFrames.map(f => ({ editUnit: f.editUnit, data: f.data, aes3: f.aes3 })),
          { bitDepth: sd.bitDepth, blockAlign: sd.blockAlign, channelCount: sd.channelCount },
        );
        post(
          { type: 'pcmSamples', samples: float32, editUnit: startFrame, sampleRate: sd.sampleRate, channelCount },
          [float32.buffer],
        );
      } else {
        const seg = fragmenter.buildAudioSegment(audioFrames);
        if (seg) {
          post(
            { type: 'audioSegment', data: seg.buffer as ArrayBuffer, seq: seqBase + 1, editUnit: startFrame },
            [seg.buffer],
          );
        }
      }
    }

    if (!isScrubPreview) post({ type: 'segmentDone' });

  } catch (e) {
    postError(`Failed to fetch segment: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // Always answer a scrub preview, even when superseded (gen mismatch returns above) or errored,
    // so the player's single-flight pump can fire the next preview at the latest dragged position.
    if (isScrubPreview) post({ type: 'previewDone', seq: previewSeq!, editUnit: startFrame });
  }
}

function handleSeek(targetFrame: number): void {
  if (!mxfFile) { postError('Not initialized'); return; }
  const bootstrap = mxfFile.getBootstrap();
  if (!bootstrap) { postError('Bootstrap not complete'); return; }

  // Reset MPEG-2 transcode state on seek. Dropping the decoder's reference frames is
  // required: the post-seek fetch starts at a keyframe (GOP boundary, carrying a fresh
  // sequence header), and stale references from the old position would corrupt the
  // first decoded pictures. The counter is reset so timestamps resume from the seek point.
  const resolvedSeek = resolveFrameOffset(
    bootstrap.indexSegments,
    BigInt(targetFrame),
    bootstrap.essenceStart,
    bootstrap.essenceBodySID,
  );
  // Supersede any queued/in-flight fetch from the old position (see FetchQueue.supersede): an
  // in-flight fetch checks the generation after its awaits and discards its now-stale frames.
  fetchQ.supersede();

  const nearestKeyframe = resolvedSeek ? Number(resolvedSeek.nearestKeyframeEditUnit) : targetFrame;
  // Resets the decoder's references + resumes the edit-unit counter from the keyframe (no-op for
  // the H.264 path, where there is no pipeline and the counter is unused).
  mpeg2Pipeline?.reset(nearestKeyframe);

  const gopFrameCount = gopLengthFromKeyframe(bootstrap.indexSegments, BigInt(nearestKeyframe));
  post({ type: 'seeked', nearestKeyframeEditUnit: nearestKeyframe, gopFrameCount });
}

/**
 * Fast-drag scrub preview in a single round-trip: resolve the GOP-head keyframe for `targetFrame`,
 * reset the decoder there (superseding any in-flight work), then enqueue a one-frame decode whose
 * sample is stretched to span the GOP. Replies with `previewDone{seq}` (always — see the finally in
 * handleFetchSegment) so the player's single-flight pump can advance to the latest dragged position.
 * Folding the seek + fetch into one command halves message latency versus seek→seeked→fetch, which
 * matters while dragging.
 */
function handleScrubPreview(targetFrame: number, seq: number): void {
  if (!mxfFile) { post({ type: 'previewDone', seq, editUnit: targetFrame }); return; }
  const bootstrap = mxfFile.getBootstrap();
  if (!bootstrap) { post({ type: 'previewDone', seq, editUnit: targetFrame }); return; }

  const resolved = resolveFrameOffset(
    bootstrap.indexSegments,
    BigInt(targetFrame),
    bootstrap.essenceStart,
    bootstrap.essenceBodySID,
  );
  const keyframe = resolved ? Number(resolved.nearestKeyframeEditUnit) : targetFrame;

  // Cache hit: this GOP head was already decoded+encoded this session — re-serve its segment
  // verbatim with no decode/encode (and without disturbing the decoder state). Dragging within a
  // GOP, or back over a visited region, becomes instant. Post a fresh copy since the buffer is
  // transferred to the main thread.
  const cached = scrubSegmentCache.get(keyframe);
  if (cached) {
    const copy = cached.slice();
    post({ type: 'videoSegment', data: copy.buffer as ArrayBuffer, seq: scrubSeqBase, editUnit: keyframe }, [copy.buffer]);
    scrubSeqBase += 2;
    post({ type: 'previewDone', seq, editUnit: keyframe });
    return;
  }

  // Fetch a small CONTIGUOUS run of real frames starting AT the keyframe (the player renders the
  // keyframe, not the mid-GOP target — standard keyframe-granularity scrub). A paused <video> paints
  // a seek into a contiguous multi-frame region (exactly why scrubbing the already-buffered area
  // works) but will NOT settle on a lone stretched sample. ~0.4 s of lookahead is enough contiguous
  // future data to paint, while keeping the per-preview decode small — critical for MPEG-2, where
  // decoding a whole GOP+lookahead per preview saturated the worker so nothing painted. Constant per
  // keyframe (independent of target) so it stays cacheable.
  const fps = storedEditRateNumerator / storedEditRateDenominator;
  const runFrames = 1 + Math.max(SCRUB_PREVIEW_MIN_LOOKAHEAD_FRAMES, Math.round(fps * SCRUB_PREVIEW_LOOKAHEAD_SECONDS));

  // Seek part (mirrors handleSeek): supersede in-flight work and reset the decoder to the keyframe.
  fetchQ.supersede();
  mpeg2Pipeline?.reset(keyframe);

  // Enqueue the throwaway decode (serialized via the queue so it can't race a normal fetch).
  // stretchToFrames stays 0 — these are real consecutive frames, so the segment is naturally
  // contiguous and the element can paint a paused seek into it.
  fetchQ.enqueue({ startFrame: keyframe, frameCount: runFrames, seqBase: scrubSeqBase, previewSeq: seq });
  scrubSeqBase += 2;
}

// Command dispatch: one handler per command type. Each handler's parameter is narrowed to the
// matching member of the WorkerCommand union, so adding a command is a single entry here (plus the
// union itself) rather than a new switch case. The dispatch cast is the standard discriminated-union
// map idiom — the lookup picks the right handler by cmd.type before the call.
type CommandHandlers = { [K in WorkerCommand['type']]: (cmd: Extract<WorkerCommand, { type: K }>) => void };

const commandHandlers: CommandHandlers = {
  initUrl: (cmd) => {
    videoMode = cmd.videoMode ?? 'mse';
    handleInit(new HttpLoader(cmd.url), cmd.debug).catch(e => postError(String(e), true));
  },
  initFile: (cmd) => {
    videoMode = cmd.videoMode ?? 'mse';
    handleInit(new FileLoader(cmd.file), cmd.debug).catch(e => postError(String(e), true));
  },
  fetchSegment: (cmd) => {
    fetchQ.enqueue({
      startFrame: cmd.startFrame,
      frameCount: cmd.frameCount,
      seqBase: cmd.seqBase,
      stretchToFrames: cmd.stretchToFrames ?? 0,
    });
  },
  seek: (cmd) => handleSeek(cmd.targetFrame),
  scrubPreview: (cmd) => handleScrubPreview(cmd.targetFrame, cmd.seq),
};

self.addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
  const cmd = event.data;
  (commandHandlers[cmd.type] as (c: WorkerCommand) => void)(cmd);
});
