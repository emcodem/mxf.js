import { HttpLoader } from '../loader/http-loader.js';
import { FileLoader } from '../loader/file-loader.js';
import { ILoader } from '../loader/loader.js';
import { MxfFile } from '../mxf-file.js';
import type { MxfBootstrap } from '../mxf-file.js';
import { EssenceExtractor } from '../essence/essence-extractor.js';
import { Mp4Fragmenter } from '../remuxer/mp4-fragmenter.js';
import {
  resolveFrameOffset, gopLengthFromKeyframe,
  resolveLongGopKeyframe, findKeyframeFloor, findKeyframeCeil, longGopGopLength, resolveEntryMeta,
} from '../parser/index-table.js';
import { isAnnexB, annexBtoAVCC, extractSPSPPS, buildAVCDecoderConfigRecord } from '../essence/avc-tools.js';
import { parseSpsPocInfo, buildPpsPocMap } from '../essence/h264-poc.js';
import type { SpsPocInfo, PpsPocInfo } from '../essence/h264-poc.js';
import { resolveReorder, accessUnitHasBSlice } from '../essence/reorder-resolver.js';
import type { ReorderInputFrame } from '../essence/reorder-resolver.js';
import { SparseKeyframeIndex } from '../essence/sparse-keyframe-index.js';
import { selectNoIndexLongGopRun, NOINDEX_GOP_LOOKAHEAD } from './longgop-noindex.js';
import { decodePcmElements } from '../audio/pcm.js';
import { WorkerCommand, WorkerEvent, TimecodeAnchor } from './worker-messages.js';
import type { EssenceFrame } from '../essence/essence-extractor.js';
import { timecodeToFrameCount, Timecode } from '../parser/timecode.js';
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

// H.264 Long-GOP (XAVC-L) reorder state: set during handleInit when B-frames are detected. The
// fetch path then reconstructs PTS/DTS via the index temporalOffset (Tier 1) or parsed POC (Tier 2).
let longGop: {
  sps: SpsPocInfo;
  ppsFlagMap: Map<number, PpsPocInfo>;
} | null = null;
// True for the first long-GOP fetch after a seek/scrub-reset: enables open-GOP leading-B drop so the
// keyframe (not an undecodable leading B) lands first. Set by handleSeek/handleScrubPreview/init.
let longGopBoundaryPending = true;
// Tier-3 (indexMode 'none') only: lazily-built keyframe map (edit unit → byte offset) populated as a
// side effect of no-index scans, so a seek can resume near the target instead of rescanning from 0.
let sparseKf: SparseKeyframeIndex | null = null;

// Speculative read-ahead (MPEG-2 forward-play only): the byte-fetch of the NEXT contiguous chunk is
// kicked off right before the current chunk's (event-loop-blocking) decode, so its download runs on
// the network thread DURING the decode instead of after it. Without it the worker reads then decodes
// SERIALLY, leaving the network idle through every decode — so on a bandwidth-constrained line
// download+decode is ~break-even and the forward buffer can't grow (sustained play stutters). Keyed by
// (startFrame, frameCount, gen); a mismatch (ramp step, seek) is a cheap miss → normal read; supersede
// aborts it. Confined to the MPEG-2 transcode path (where decode dominates); H.264 remux is unaffected.
let speculativePrefetch:
  | { startFrame: number; frameCount: number; gen: number; abort: AbortController; promise: Promise<EssenceFrame[]> }
  | null = null;

/** Read a contiguous run of raw essence frames (exact, no keyframe snap) — the MPEG-2 read phase,
 *  used for the speculative read-ahead (a fresh EssenceExtractor + signal, independent of any job). */
async function readRawFrames(startFrame: number, frameCount: number, signal: AbortSignal): Promise<EssenceFrame[]> {
  const extractor = new EssenceExtractor(loader!, mxfFile!.getBootstrap()!, signal);
  const frames: EssenceFrame[] = [];
  for await (const frame of extractor.fetchFrames(BigInt(startFrame), frameCount, true)) frames.push(frame);
  return frames;
}

/** Abort + drop any in-flight speculative read-ahead (on supersede, or before a fresh non-matching read). */
function abortSpeculation(): void {
  if (speculativePrefetch) { speculativePrefetch.abort.abort(); speculativePrefetch = null; }
}

// Serializes fetches (one at a time) and lets a seek discard superseded work — see FetchQueue.
// run executes one job by delegating to handleFetchSegment (hoisted, so referencing it here is fine).
// onSupersede aborts the speculative read-ahead in the same choke point that drops queued jobs.
const fetchQ = new FetchQueue(
  (job, signal) =>
    handleFetchSegment(job.startFrame, job.frameCount, job.seqBase, job.gen, job.stretchToFrames, job.previewSeq, signal),
  abortSpeculation,
);
// seqBase pool for internally-scheduled scrub-preview decodes (kept apart from the player's seqBase).
let scrubSeqBase = 1_000_000;

// Scrub-preview cache (GOP-head keyframe edit unit → encoded fMP4 video segment); see
// ScrubSegmentCache for why this is what makes MPEG-2 scrubbing usable. Cleared on each file load.
const scrubSegmentCache = new ScrubSegmentCache();

function post(event: WorkerEvent, transferables: Transferable[] = []): void {
  self.postMessage(event, transferables);
}

/**
 * Compress per-frame System Item timecodes into the minimal set of anchors: keep the first, then
 * keep only frames whose timecode breaks linear continuation from the previous kept anchor (a
 * "jump", or a base/drop-frame change). A continuous segment → one anchor; the player interpolates
 * the rest. `pairs` are (presentation edit unit, timecode) — undefined timecodes are dropped.
 */
function buildTcAnchors(pairs: { editUnit: number; tc?: Timecode }[]): TimecodeAnchor[] {
  const sorted = pairs.filter(p => p.tc).sort((a, b) => a.editUnit - b.editUnit);
  const anchors: TimecodeAnchor[] = [];
  let prev: TimecodeAnchor | null = null;
  for (const p of sorted) {
    const tc = p.tc!;
    const fc = timecodeToFrameCount(tc);
    if (prev && prev.base === tc.base && prev.dropFrame === tc.dropFrame &&
        fc === prev.frameCount + (p.editUnit - prev.editUnit)) continue; // linear → skip
    prev = { editUnit: p.editUnit, frameCount: fc, base: tc.base, dropFrame: tc.dropFrame };
    anchors.push(prev);
  }
  return anchors;
}

/** Pack the parsed package timecodes for the manifest (bigint position → number for the wire). */
function manifestTimecodes(metadata: { timecodes: { source: 'material'|'file'|'source'; position: bigint; base: number; dropFrame: boolean; editRateNumerator: number; editRateDenominator: number }[] }) {
  return metadata.timecodes.map(t => ({
    source: t.source, position: Number(t.position), base: t.base, dropFrame: t.dropFrame,
    editRateNumerator: t.editRateNumerator, editRateDenominator: t.editRateDenominator,
  }));
}

function postError(message: string, fatal = false): void {
  post({ type: 'error', message, fatal });
}

async function handleInit(loader_: ILoader, debug = false): Promise<void> {
  loader = loader_;
  workerDebug = debug;
  mxfFile = new MxfFile(loader, debug);
  mpeg2Pipeline = null;
  longGop = null;
  longGopBoundaryPending = true;
  sparseKf = null;
  abortSpeculation();
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
      // Find the first video frame for the probe-decode. The index path fetches the WHOLE requested
      // range in one HTTP read before yielding (essence-extractor.ts), so the old `fetchFrames(0n, 50)`
      // pulled ~50 edit units (~2 s of bytes on a thin line) just to grab frame 0 — then the cold-start
      // ramp re-reads frame 0 anyway. Standard OP1a/D-10 puts the first picture element in edit unit 0,
      // so read just the first edit unit or two; escalate to the wide scan only if pathological
      // interleaving hides it, keeping the common case a tiny read.
      let firstVideoFrame: EssenceFrame | null = null;
      for (const probeCount of [2, 50]) {
        const extractor = new EssenceExtractor(loader_, bootstrap);
        for await (const frame of extractor.fetchFrames(0n, probeCount)) {
          if (frame.trackType === 'video') { firstVideoFrame = frame; break; }
        }
        if (firstVideoFrame) break;
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
      // Pass the display (active) dims too — the fragmenter derives the pixel aspect ratio (pasp)
      // from them and the descriptor's DAR, so anamorphic SD/XDCAM-EX renders at the right shape.
      fragmenter!.enableTranscodeMode(pipeline.sps, pipeline.pps, pipeline.codedWidth, pipeline.codedHeight, pipeline.displayWidth, pipeline.displayHeight);

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
        timecodes: manifestTimecodes(metadata),
        pictureDescriptor: pd,
        soundDescriptor: sd,
        // Display dims from the elementary stream (active picture), not the per-field descriptor.
        displayWidth: pipeline.displayWidth,
        displayHeight: pipeline.displayHeight,
        aspectRatio: pd?.aspectRatioNum && pd?.aspectRatioDen ? { num: pd.aspectRatioNum, den: pd.aspectRatioDen } : null,
        videoCodecSupported: true,
        pcmMseSupported: false,
        // Codec string from the actual SPS bytes so it matches the constraint byte in the avcC box
        // (decoderConfig.codec may report constraints=0x00 while the SPS has e.g. 0x4c — that
        // mismatch causes a SourceBuffer error when Chrome checks MIME vs avcC on init append).
        resolvedVideoCodec: pipeline.codecString,
        resolvedVideoMode: 'mse',
        indexMode: bootstrap.indexMode,
        longGop: false, // MPEG-2 transcode path handles reorder inside the decoder, not here
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
    // Display dims for the manifest. Default to the descriptor's stored dims; H.264 overrides below
    // with the SPS-coded frame size (the descriptor's StoredHeight is per-field for interlaced AVC).
    let videoDisplayWidth = pd?.storedWidth ?? 0;
    let videoDisplayHeight = pd?.storedHeight ?? 0;

    if (pd?.codec === 'h264') {
      // The init segment's avc1/avcC box is built from the SPS/PPS in the FIRST video frame (it must
      // be a keyframe carrying parameter sets). If that extraction fails there is no correct init
      // segment to build, so fail loudly rather than guessing dimensions (see mp4-fragmenter).
      let gotSpsPps = false;
      let spsPocInfo: SpsPocInfo | null = null;
      let ppsFlagMap: Map<number, PpsPocInfo> = new Map();
      try {
        const extractor = new EssenceExtractor(loader_, bootstrap);
        for await (const frame of extractor.fetchFrames(0n, 1)) {
          if (frame.trackType !== 'video') continue;
          const avccData = isAnnexB(frame.data) ? annexBtoAVCC(frame.data) : frame.data;
          const { sps, pps } = extractSPSPPS(avccData);
          if (sps.length > 0 && pps.length > 0) {
            gotSpsPps = true;
            fragmenter!.setSPSPPS(sps, pps);
            // Parse POC syntax from the in-band parameter sets so the fetch path can reorder B-frames.
            spsPocInfo = parseSpsPocInfo(sps[0]);
            ppsFlagMap = buildPpsPocMap(pps);
            // The SPS gives the real picture size (active/cropped, e.g. 1920×1080), unlike the
            // descriptor's per-field StoredHeight (544). Surface it as the manifest display size.
            if (spsPocInfo) { videoDisplayWidth = spsPocInfo.displayWidth; videoDisplayHeight = spsPocInfo.displayHeight; }
            if (videoMode === 'webcodecs') {
              const desc = buildAVCDecoderConfigRecord(sps, pps);
              const p = sps[0][1], c = sps[0][2], l = sps[0][3];
              const codec = `avc1.${p.toString(16).padStart(2,'0')}${c.toString(16).padStart(2,'0')}${l.toString(16).padStart(2,'0')}`;
              pendingVideoInit = { codec, description: desc, width: pd.width, height: pd.height };
            }
          }
          break;
        }
      } catch (e) {
        postError(`H.264: failed to read SPS/PPS from the first frame: ${e instanceof Error ? e.message : String(e)}`, true);
        return;
      }
      if (!gotSpsPps) {
        postError('H.264: no SPS/PPS in the first video frame — cannot build an init segment (the first frame must be a keyframe carrying parameter sets)', true);
        return;
      }

      // Detect Long-GOP: probe ~2 GOPs for any B slice. Reorder works with a VBE index (GOP-aligned
      // via the index entry flags — Tier 1/2) and with NO index (Tier 3: GOP-aligned by scanning for
      // IDRs, with a lazily-built SparseKeyframeIndex). CBG is all-intra, so it's skipped.
      if (spsPocInfo && (bootstrap.indexMode === 'vbe' || bootstrap.indexMode === 'none') && videoMode !== 'webcodecs') {
        try {
          const probe = new EssenceExtractor(loader_, bootstrap);
          let seen = 0;
          for await (const frame of probe.fetchFrames(0n, 30)) {
            if (frame.trackType !== 'video') continue;
            seen++;
            const avcc = isAnnexB(frame.data) ? new Uint8Array(annexBtoAVCC(frame.data)) : new Uint8Array(frame.data);
            if (accessUnitHasBSlice(avcc, spsPocInfo, ppsFlagMap)) {
              longGop = { sps: spsPocInfo, ppsFlagMap };
              break;
            }
            if (seen >= 30) break;
          }
          // Tier 3: a no-index long-GOP file needs the sparse keyframe map; the fetch/seek paths
          // populate it as they scan (the probe above is too short to seed it meaningfully).
          if (longGop && bootstrap.indexMode === 'none') sparseKf = new SparseKeyframeIndex();
          if (workerDebug) console.log(`[longgop] detection: ${longGop ? `Long-GOP (B-frames present, ${bootstrap.indexMode} index)` : 'all-predictive/intra (no reorder)'}`);
        } catch (e) {
          if (workerDebug) console.log('[longgop] B-slice probe failed, treating as non-Long-GOP:', e);
        }
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
      timecodes: manifestTimecodes(metadata),
      pictureDescriptor: pd,
      soundDescriptor: sd,
      displayWidth: videoDisplayWidth,
      displayHeight: videoDisplayHeight,
      aspectRatio: pd?.aspectRatioNum && pd?.aspectRatioDen ? { num: pd.aspectRatioNum, den: pd.aspectRatioDen } : null,
      videoCodecSupported,
      pcmMseSupported: false,
      resolvedVideoCodec: pd?.codec ?? 'unknown',
      resolvedVideoMode: resolvedMode,
      indexMode: bootstrap.indexMode,
      longGop: longGop !== null,
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
  signal?: AbortSignal,
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
    const extractor = new EssenceExtractor(loader, bootstrap, signal);

    // Long-GOP fetches are GOP-aligned: snap the start back to its keyframe floor and extend the
    // end forward to the next keyframe, so the run is whole GOPs (POC ranking is complete and
    // segments tile). `exact` so storage edit units are numbered from the real keyframe EU.
    let fetchStart = startFrame;
    let fetchCount = frameCount;
    let lgNextFrame = startFrame + frameCount; // reported to the player as the next fetch start
    let videoFrames: EssenceFrame[];
    let audioFrames: EssenceFrame[];

    // Tier 3: no usable index → can't resolve GOP boundaries by math. Scan from the nearest known
    // keyframe (SparseKeyframeIndex floor, else the essence start), classify IDRs, retain only the
    // enclosing GOP run, and record discovered keyframes. Memory-safe (scanned-past frames are
    // discarded), so even a cold seek that rescans from the start doesn't buffer the whole file.
    const noIndexLongGop = !!longGop && !mpeg2Pipeline && bootstrap.indexMode === 'none';
    if (noIndexLongGop) {
      // Resume the scan at the nearest known keyframe (else the essence start), reading enough to
      // cover the window plus a lookahead to reach the next IDR (GOP boundary).
      const floor = sparseKf?.floor(BigInt(startFrame)) ?? null;
      const scanEU = floor ? Number(floor.editUnit) : 0;
      const fromByteOffset = floor ? floor.byteOffset : bootstrap.essenceStart;
      const scanBound = (startFrame + frameCount - scanEU) + NOINDEX_GOP_LOOKAHEAD;
      const run = await selectNoIndexLongGopRun(
        extractor.fetchFrames(BigInt(scanEU), scanBound, false, fromByteOffset),
        { startFrame, frameCount, scanBound, sparseKf, isAborted: () => gen !== fetchQ.currentGeneration },
      );
      if (run === null) return; // superseded mid-scan
      videoFrames = run.video;
      audioFrames = run.audio;
      fetchStart = run.startStorageEU;
      lgNextFrame = run.nextFrame;
    } else {
      if (longGop && !mpeg2Pipeline) {
        const segs = bootstrap.indexSegments, vid = bootstrap.essenceBodySID;
        const kStart = findKeyframeFloor(segs, BigInt(startFrame), vid);
        const kEnd = findKeyframeCeil(segs, BigInt(startFrame + frameCount), vid);
        if (kStart !== null) fetchStart = Number(kStart);
        lgNextFrame = kEnd !== null ? Number(kEnd) : startFrame + frameCount;
        fetchCount = Math.max(1, lgNextFrame - fetchStart);
      }

      // The MPEG-2 transcode path feeds one persistent decoder, so it needs the exact
      // consecutive frame range (no keyframe snapping) to avoid re-feeding pictures it has
      // already decoded. Long-GOP also fetches exact (from the snapped keyframe). Seeks land on a
      // keyframe anyway, where exact and snapped agree.
      const exact = !!mpeg2Pipeline || !!longGop;

      // MPEG-2 forward play: if the previous segment speculatively prefetched THIS exact chunk, its
      // bytes are already downloading/done — await that instead of starting the read serially after
      // the previous decode. Otherwise read fresh (and drop any non-matching speculation).
      const specHit = !!mpeg2Pipeline && !!speculativePrefetch
        && speculativePrefetch.startFrame === fetchStart
        && speculativePrefetch.frameCount === fetchCount
        && speculativePrefetch.gen === gen;
      let frames: EssenceFrame[];
      if (specHit) {
        frames = await speculativePrefetch!.promise;
        speculativePrefetch = null;
      } else {
        abortSpeculation();
        frames = [];
        for await (const frame of extractor.fetchFrames(BigInt(fetchStart), fetchCount, exact)) {
          frames.push(frame);
        }
      }

      // A seek arrived while we were reading bytes: the decoder has been reset to a new
      // position, so feeding it these (now stale) frames would corrupt the post-seek decode.
      // Drop this fetch entirely; the player issues a fresh fetch after the 'seeked' event.
      if (gen !== fetchQ.currentGeneration) return;

      videoFrames = frames.filter(f => f.trackType === 'video');
      audioFrames = frames.filter(f => f.trackType === 'audio');

      // Kick off the NEXT contiguous chunk's read NOW — before the decode below — so its download runs
      // on the network thread DURING this segment's decode (which otherwise blocks the event loop and
      // idles the network). Forward MPEG-2 only; skip at EOF (short read) and for previews / stretched
      // keyframe fetches (non-contiguous and superseded constantly).
      if (mpeg2Pipeline && !isScrubPreview && stretchToFrames === 0 && videoFrames.length === fetchCount) {
        const nextStart = fetchStart + fetchCount;
        const ab = new AbortController();
        const promise = readRawFrames(nextStart, fetchCount, ab.signal);
        // Detached handler so an abort before a job claims this promise isn't an unhandled rejection;
        // a claiming job still awaits `promise` and handles its own errors via the outer try/catch.
        promise.catch(() => {});
        speculativePrefetch = { startFrame: nextStart, frameCount: fetchCount, gen, abort: ab, promise };
      }
    }

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
          // The decoder's display reorder isn't tracked per-frame here, so emit a single base anchor:
          // the earliest source TC (displays first in a forward GOP) at the first displayed edit unit.
          // Exact for continuous timecode; best-effort across a mid-segment jump (next segment re-anchors).
          let tcAnchors: TimecodeAnchor[] | undefined;
          const tcs = videoFrames.map(f => f.systemTimecode).filter((t): t is Timecode => !!t);
          if (tcs.length > 0 && chunks.length > 0) {
            let ref = tcs[0], minFc = timecodeToFrameCount(tcs[0]);
            for (const t of tcs) { const fc = timecodeToFrameCount(t); if (fc < minFc) { minFc = fc; ref = t; } }
            tcAnchors = [{ editUnit: Number(chunks[0].editUnit), frameCount: minFc, base: ref.base, dropFrame: ref.dropFrame }];
          }
          post(
            { type: 'videoSegment', data: seg.buffer as ArrayBuffer, seq: seqBase, editUnit: startFrame, systemTcAnchors: tcAnchors },
            [seg.buffer],
          );
        }
      }
    } else if (longGop) {
      // -----------------------------------------------------------------------
      // H.264 Long-GOP (XAVC-L): reconstruct B-frame display order, then remux (fragmenter
      // unchanged — it honours the per-sample pts/dts/isKeyframe we attach here).
      // -----------------------------------------------------------------------
      if (videoFrames.length > 0) {
        const segs = bootstrap.indexSegments, vid = bootstrap.essenceBodySID;
        const isBoundary = longGopBoundaryPending;
        longGopBoundaryPending = false;

        const inputs: ReorderInputFrame[] = videoFrames.map(f => ({
          avcc: isAnnexB(f.data) ? new Uint8Array(annexBtoAVCC(f.data)) : new Uint8Array(f.data),
          editUnit: f.editUnit,
          meta: resolveEntryMeta(segs, f.editUnit, vid),
        }));
        const resolved = resolveReorder(inputs, {
          sps: longGop.sps,
          ppsFlagMap: longGop.ppsFlagMap,
          startStorageEU: BigInt(fetchStart),
          isRunKeyframeBoundary: isBoundary,
        });

        // Attach the resolved PTS/DTS/isKeyframe to the source frames (decode order, kept frames).
        const reordered: EssenceFrame[] = resolved.map(s => ({
          ...videoFrames[s.sourceIndex],
          pts: s.pts,
          dts: s.dts,
          isKeyframe: s.isKeyframe,
        }));
        const seg = fragmenter.buildVideoSegment(reordered);
        if (seg) {
          if (workerDebug) console.log(`[longgop] fetch ${fetchStart}..${lgNextFrame - 1} (req ${startFrame}+${frameCount})${isBoundary ? ' [boundary, leading-B drop]' : ''}: ${videoFrames.length} AUs → ${resolved.length} samples`);
          if (isScrubPreview) scrubSegmentCache.set(startFrame, seg.slice());
          // System-item TC anchors: key by the source frame's STORAGE edit unit, NOT its presentation
          // pts. The System Item sits in the content package in storage (decode) order, so its TC value
          // is a function of the storage position — for XAVC-L it counts linearly in storage order
          // (verify-meta: 00,00,01,01,02,02… on xavc_l_1080p50). Pairing that storage-linear clock to
          // the reordered presentation pts scrambles it (B-frame reorder), so stepping through display
          // order showed a non-monotonic SYS TC. Anchoring by storage editUnit keeps the run linear →
          // ~1 anchor/segment, and the player's nearest-anchor + offset reconstructs base+editUnit at
          // any presentation query (exact for continuous TC; a real TC jump lands within the reorder
          // distance of its frame — the same best-effort the MPEG-2 path accepts).
          const tcAnchors = buildTcAnchors(reordered.map(f => ({ editUnit: Number(f.editUnit), tc: f.systemTimecode })));
          post(
            { type: 'videoSegment', data: seg.buffer as ArrayBuffer, seq: seqBase, editUnit: fetchStart, nextFrame: lgNextFrame, systemTcAnchors: tcAnchors.length ? tcAnchors : undefined },
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
            // All-intra (no reorder): storage edit unit == presentation edit unit, so anchor directly.
            const tcAnchors = buildTcAnchors(videoFrames.map(f => ({ editUnit: Number(f.editUnit), tc: f.systemTimecode })));
            post(
              { type: 'videoSegment', data: seg.buffer as ArrayBuffer, seq: seqBase, editUnit: startFrame, systemTcAnchors: tcAnchors.length ? tcAnchors : undefined },
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
    // A read aborted by a seek/scrub supersession is expected — the next fetch is already queued, so
    // swallow it (and any error once superseded) rather than surfacing a spurious error to the player.
    const aborted = (e instanceof Error && e.name === 'AbortError') || signal?.aborted || gen !== fetchQ.currentGeneration;
    if (!aborted) postError(`Failed to fetch segment: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // Always answer a scrub preview, even when superseded (gen mismatch returns above) or errored,
    // so the player's single-flight pump can fire the next preview at the latest dragged position.
    if (isScrubPreview) post({ type: 'previewDone', seq: previewSeq!, editUnit: startFrame });
  }
}

/**
 * Resolve the random-access keyframe edit unit for a seek/scrub target: the nearest preceding
 * keyframe via the long-GOP-aware predicate when reordering, else the standard resolver. Returns
 * `targetFrame` itself when the index can't resolve it (caller seeks there directly).
 */
function resolveKeyframeFor(bootstrap: MxfBootstrap, targetFrame: number): number {
  const resolved = longGop
    ? resolveLongGopKeyframe(bootstrap.indexSegments, BigInt(targetFrame), bootstrap.essenceStart, bootstrap.essenceBodySID)
    : resolveFrameOffset(bootstrap.indexSegments, BigInt(targetFrame), bootstrap.essenceStart, bootstrap.essenceBodySID);
  return resolved ? Number(resolved.nearestKeyframeEditUnit) : targetFrame;
}

function handleSeek(targetFrame: number): void {
  if (!mxfFile) { postError('Not initialized'); return; }
  const bootstrap = mxfFile.getBootstrap();
  if (!bootstrap) { postError('Bootstrap not complete'); return; }

  // Reset MPEG-2 transcode state on seek. Dropping the decoder's reference frames is
  // required: the post-seek fetch starts at a keyframe (GOP boundary, carrying a fresh
  // sequence header), and stale references from the old position would corrupt the
  // first decoded pictures. The counter is reset so timestamps resume from the seek point.
  // Supersede any queued/in-flight fetch from the old position (see FetchQueue.supersede): an
  // in-flight fetch checks the generation after its awaits and discards its now-stale frames.
  fetchQ.supersede();

  // Long-GOP uses the auto-detecting keyframe predicate (the legacy 0x80 test mis-detects every
  // ffmpeg-VBE frame as a keyframe); other codecs keep the original resolution.
  let nearestKeyframe: number;
  let gopFrameCount: number;
  if (longGop && bootstrap.indexMode === 'none') {
    // Tier 3: snap to the nearest discovered keyframe (the fetch path refines it by scanning for the
    // enclosing IDR). GOP length is unknown without an index, and fast scrub is disabled for 'none',
    // so report 1.
    const fl = sparseKf?.floor(BigInt(targetFrame)) ?? null;
    nearestKeyframe = fl ? Number(fl.editUnit) : targetFrame;
    gopFrameCount = 1;
  } else {
    nearestKeyframe = resolveKeyframeFor(bootstrap, targetFrame);
    gopFrameCount = longGop
      ? longGopGopLength(bootstrap.indexSegments, BigInt(nearestKeyframe), bootstrap.essenceBodySID)
      : gopLengthFromKeyframe(bootstrap.indexSegments, BigInt(nearestKeyframe));
  }

  // Resets the decoder's references + resumes the edit-unit counter from the keyframe (no-op for
  // the H.264 path, where there is no pipeline and the counter is unused).
  mpeg2Pipeline?.reset(nearestKeyframe);
  // The next fetch is the first of a new GOP run: drop open-GOP leading B's so the keyframe lands first.
  longGopBoundaryPending = true;

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

  const keyframe = resolveKeyframeFor(bootstrap, targetFrame);

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
  // This preview run starts a fresh GOP: drop open-GOP leading B's so the keyframe paints first.
  longGopBoundaryPending = true;

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
  // Scrub started: drop in-flight/queued forward prefetch so the worker is free for previews. The
  // in-flight transcode checks the generation after each frame and bails; queued jobs are cleared.
  cancelPrefetch: () => { fetchQ.supersede(); },
};

self.addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
  const cmd = event.data;
  (commandHandlers[cmd.type] as (c: WorkerCommand) => void)(cmd);
});
