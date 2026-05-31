import { HttpLoader } from '../loader/http-loader.js';
import { FileLoader } from '../loader/file-loader.js';
import { ILoader } from '../loader/loader.js';
import { MxfFile } from '../mxf-file.js';
import { EssenceExtractor } from '../essence/essence-extractor.js';
import { Mp4Fragmenter } from '../remuxer/mp4-fragmenter.js';
import { resolveFrameOffset } from '../parser/index-table.js';
import { isAnnexB, annexBtoAVCC, extractSPSPPS, buildAVCDecoderConfigRecord } from '../essence/avc-tools.js';
import { Mpeg2Decoder } from '../codec/mpeg2-decoder.js';
import { Mpeg2Transcoder } from '../codec/mpeg2-transcoder.js';
import { WorkerCommand, WorkerEvent } from './worker-messages.js';
import type { EssenceFrame } from '../essence/essence-extractor.js';

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

// MPEG-2 transcode state (null when source is not MPEG-2)
let mpeg2Decoder: Mpeg2Decoder | null = null;
let mpeg2Transcoder: Mpeg2Transcoder | null = null;
let mpeg2EditUnitCounter = 0n;

function post(event: WorkerEvent, transferables: Transferable[] = []): void {
  self.postMessage(event, transferables);
}

function postError(message: string, fatal = false): void {
  post({ type: 'error', message, fatal });
}

async function handleInit(loader_: ILoader, debug = false): Promise<void> {
  loader = loader_;
  mxfFile = new MxfFile(loader, debug);
  mpeg2Decoder = null;
  mpeg2Transcoder = null;
  mpeg2EditUnitCounter = 0n;

  try {
    const bootstrap = await mxfFile.open();
    const { metadata } = bootstrap;
    fragmenter = new Mp4Fragmenter(metadata);
    const pd = metadata.pictureDescriptor;
    const sd = metadata.soundDescriptor;
    storedEditRateNumerator = metadata.editRateNumerator;
    storedEditRateDenominator = metadata.editRateDenominator;

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

      // Decode the first frame to discover dimensions and chroma format
      let firstYuv: ReturnType<typeof Object.assign> | null = null;
      const dec = new Mpeg2Decoder((yuv) => {
        if (!firstYuv) {
          // Copy buffers — decoder reuses them
          firstYuv = {
            y: yuv.y.slice(), cb: yuv.cb.slice(), cr: yuv.cr.slice(),
            codedWidth: yuv.codedWidth, codedHeight: yuv.codedHeight,
            width: yuv.width, height: yuv.height,
            chromaFormat: yuv.chromaFormat, isKeyframe: yuv.isKeyframe,
          };
        }
      });
      dec.write(firstVideoFrame.data);
      dec.decode();
      dec.flush();

      if (!firstYuv) {
        postError('MPEG-2: failed to decode first frame', true);
        return;
      }

      const yuv = firstYuv as {
        y: Uint8ClampedArray; cb: Uint8ClampedArray; cr: Uint8ClampedArray;
        codedWidth: number; codedHeight: number; width: number; height: number;
        chromaFormat: number; isKeyframe: boolean;
      };

      const fps = storedEditRateNumerator / storedEditRateDenominator;
      const transcoder = new Mpeg2Transcoder(
        yuv.codedWidth, yuv.codedHeight,
        yuv.width, yuv.height,
        fps,
      );

      // Encode first frame to force the encoder to emit SPS/PPS
      transcoder.encodeFrame(yuv, 0, true);
      await transcoder.flush(); // discard chunk — we only need spspps here
      const spspps = transcoder.spspps;
      if (!spspps) {
        transcoder.close();
        postError('MPEG-2: VideoEncoder did not produce SPS/PPS', true);
        return;
      }

      // Use coded (MB-aligned) dimensions for the avc1 box.
      // Chrome's WebCodecs VideoEncoder does not insert frame_cropping_flag in the SPS
      // even when displayHeight < codedHeight (e.g. 1080 vs 1088).  If we declare
      // 1080 in the avc1 box but the SPS says "display = coded = 1088", Chrome's MSE
      // parser sees a mismatch and fires a SourceBuffer error.  Using codedHeight (1088)
      // keeps the container consistent with the SPS.
      fragmenter!.enableTranscodeMode(spspps.sps, spspps.pps, yuv.codedWidth, yuv.codedHeight);

      // Persistent decoder for subsequent segments (preserves reference frames)
      mpeg2Decoder = new Mpeg2Decoder(() => { /* filled in handleFetchSegment */ });
      mpeg2Transcoder = transcoder;

      // PCM audio uses Web Audio — skip audio track from moov entirely.
      // Chrome MSE rejects init segments containing unknown codec sample entries
      // (sowt) even when the SourceBuffer is video-only.
      const initSeg = fragmenter!.buildInitSegment(false);
      console.log('[worker] MPEG-2 transcode init OK',
        'sps:', Array.from(spspps.sps).map(b=>b.toString(16).padStart(2,'0')).join(' '),
        'pps:', Array.from(spspps.pps).map(b=>b.toString(16).padStart(2,'0')).join(' '),
        `dims: ${yuv.width}x${yuv.height} (coded: ${yuv.codedWidth}x${yuv.codedHeight})`,
        'initSeg bytes:', initSeg.length,
      );

      // Always derive the codec string from the actual SPS bytes so it matches the
      // constraint byte encoded in the avcC box. decoderConfig.codec may report
      // constraints=0x00 while the SPS has e.g. 0x4c — that mismatch causes a
      // SourceBuffer error when Chrome checks MIME vs avcC on init-segment append.
      const p = spspps.sps[1].toString(16).padStart(2, '0');
      const c = spspps.sps[2].toString(16).padStart(2, '0');
      const l = spspps.sps[3].toString(16).padStart(2, '0');
      const actualCodecStr = `avc1.${p}${c}${l}`;

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
        resolvedVideoCodec: actualCodecStr,
        resolvedVideoMode: 'mse',
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

async function handleFetchSegment(startFrame: number, frameCount: number, seqBase: number): Promise<void> {
  if (!loader || !mxfFile || !fragmenter) { postError('Not initialized'); return; }
  const bootstrap = mxfFile.getBootstrap();
  if (!bootstrap) { postError('Bootstrap not complete'); return; }

  try {
    const extractor = new EssenceExtractor(loader, bootstrap);
    const frames: EssenceFrame[] = [];
    for await (const frame of extractor.fetchFrames(BigInt(startFrame), frameCount)) {
      frames.push(frame);
    }

    const videoFrames = frames.filter(f => f.trackType === 'video');
    const audioFrames = frames.filter(f => f.trackType === 'audio');

    // -----------------------------------------------------------------------
    // MPEG-2 → H.264 transcode
    // -----------------------------------------------------------------------
    if (mpeg2Transcoder && mpeg2Decoder) {
      if (videoFrames.length > 0) {
        const transcoder = mpeg2Transcoder;
        const frameDurUs = Math.round(storedEditRateDenominator * 1_000_000 / storedEditRateNumerator);
        let isFirstFrameOfSegment = true;

        // Fresh decoder per segment — avoids stale reference frames across seek boundaries.
        const segDecoder = new Mpeg2Decoder((yuv) => {
          const tsUs = Number(mpeg2EditUnitCounter) * frameDurUs;
          const forceKey = isFirstFrameOfSegment;
          isFirstFrameOfSegment = false;
          transcoder.encodeFrame(yuv, tsUs, forceKey);
          mpeg2EditUnitCounter++;
        });

        for (const vf of videoFrames) {
          segDecoder.write(vf.data);
          while (segDecoder.decode()) { /* onFrame fires inside decode() */ }
        }
        segDecoder.flush(); // emit any held anchor

        const chunks = await transcoder.flush();
        // Assign edit units to chunks
        const firstEu = BigInt(startFrame);
        for (let i = 0; i < chunks.length; i++) {
          chunks[i].editUnit = firstEu + BigInt(i);
        }

        const seg = fragmenter.buildTranscodedVideoSegment(chunks);
        if (seg) {
          console.log('[worker] videoSegment', seg.length, 'bytes,', chunks.length, 'chunks, first chunk keyframe:', chunks[0]?.isKeyframe, 'first chunk size:', chunks[0]?.data.byteLength);
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
            post(
              { type: 'videoSegment', data: seg.buffer as ArrayBuffer, seq: seqBase, editUnit: startFrame },
              [seg.buffer],
            );
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Audio
    // -----------------------------------------------------------------------
    if (audioFrames.length > 0) {
      const sd = bootstrap.metadata.soundDescriptor;
      if (sd?.codec === 'pcm') {
        const rawPCM = audioFrames.reduce((acc, f) => acc + f.data.byteLength, 0);
        const combined = new Int16Array(rawPCM / 2);
        let offset = 0;
        for (const frame of audioFrames) {
          const samples = new Int16Array(frame.data);
          combined.set(samples, offset);
          offset += samples.length;
        }
        const float32 = new Float32Array(combined.length);
        for (let i = 0; i < combined.length; i++) float32[i] = combined[i] / 32768;
        post(
          { type: 'pcmSamples', samples: float32, editUnit: startFrame, sampleRate: sd.sampleRate, channelCount: sd.channelCount },
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

    post({ type: 'segmentDone' });

  } catch (e) {
    postError(`Failed to fetch segment: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function handleSeek(targetFrame: number): void {
  if (!mxfFile) { postError('Not initialized'); return; }
  const bootstrap = mxfFile.getBootstrap();
  if (!bootstrap) { postError('Bootstrap not complete'); return; }

  // Reset MPEG-2 transcode counters on seek
  mpeg2EditUnitCounter = BigInt(targetFrame);

  const resolved = resolveFrameOffset(
    bootstrap.indexSegments,
    BigInt(targetFrame),
    bootstrap.essenceStart,
  );
  const nearestKeyframe = resolved ? Number(resolved.nearestKeyframeEditUnit) : targetFrame;
  post({ type: 'seeked', nearestKeyframeEditUnit: nearestKeyframe });
}

self.addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
  const cmd = event.data;
  switch (cmd.type) {
    case 'initUrl':
      videoMode = cmd.videoMode ?? 'mse';
      handleInit(new HttpLoader(cmd.url), cmd.debug).catch(e => postError(String(e), true));
      break;
    case 'initFile':
      videoMode = cmd.videoMode ?? 'mse';
      handleInit(new FileLoader(cmd.file), cmd.debug).catch(e => postError(String(e), true));
      break;
    case 'fetchSegment':
      handleFetchSegment(cmd.startFrame, cmd.frameCount, cmd.seqBase).catch(e => postError(String(e)));
      break;
    case 'seek':
      handleSeek(cmd.targetFrame);
      break;
  }
});
