import { MxfTrack } from '../parser/metadata.js';
import { PictureDescriptor, SoundDescriptor } from '../parser/descriptor.js';
import type { IndexMode } from '../mxf-file.js';

// Commands sent from main thread to worker
export type WorkerCommand =
  | { type: 'initUrl'; url: string; debug?: boolean; videoMode?: 'webcodecs' | 'mse' }
  | { type: 'initFile'; file: File; debug?: boolean; videoMode?: 'webcodecs' | 'mse' }
  | {
      type: 'fetchSegment';
      startFrame: number;
      frameCount: number;
      seqBase: number;
      /**
       * Keyframe (I-frame-only) preview: when set (>0), the worker decodes just the requested
       * frame(s) — normally a single GOP-head keyframe — and stretches the final emitted sample's
       * duration so the whole segment spans this many frame periods. The <video> then shows that
       * I-frame for any currentTime within its GOP, giving instant scrub feedback without snapping
       * the timeline thumb. Omitted/0 = normal playback fetch (one frame period per sample).
       */
      stretchToFrames?: number;
    }
  | { type: 'seek'; targetFrame: number }
  | {
      /** Abandon any in-flight/queued forward prefetch immediately (e.g. when a scrub starts), so the
       *  worker is free for previews. Bumps the seek generation so the in-flight transcode bails. */
      type: 'cancelPrefetch';
    }
  | {
      /** Fast-drag scrub: resolve the GOP-head keyframe for targetFrame, decode just that I-frame
       *  stretched across its GOP, and reply with previewDone{seq}. One round-trip (vs seek→seeked
       *  →fetch). `seq` lets the player's single-flight pump match the reply to its request. */
      type: 'scrubPreview';
      targetFrame: number;
      seq: number;
    };

// Events sent from worker to main thread
export type WorkerEvent =
  | {
      type: 'manifest';
      duration: number;  // in seconds
      editRateNumerator: number;
      editRateDenominator: number;
      tracks: MxfTrack[];
      pictureDescriptor: PictureDescriptor | null;
      soundDescriptor: SoundDescriptor | null;
      /** Active picture dimensions to DISPLAY (the real frame, not the per-field StoredHeight in the
       *  descriptor — e.g. 720×576, not 720×288). 0 when unknown. */
      displayWidth: number;
      displayHeight: number;
      /** Display aspect ratio (DAR) from the MXF descriptor (e.g. {num:16,den:9}); null = square pixels. */
      aspectRatio: { num: number; den: number } | null;
      videoCodecSupported: boolean;
      pcmMseSupported: boolean;
      /** Codec the worker will actually deliver to MSE (may differ from pictureDescriptor.codec). */
      resolvedVideoCodec: string;
      /** Whether the worker will use MSE segments or WebCodecs chunks for video. */
      resolvedVideoMode: 'mse' | 'webcodecs';
      /** Seeking strategy this file supports: 'cbg' | 'vbe' | 'none'. */
      indexMode: IndexMode;
      /** True for H.264 Long-GOP (XAVC-L) streams that need B-frame reorder (PTS/DTS) on fetch. */
      longGop: boolean;
      /** True PCM output channel count (decoded from the first audio, may exceed descriptor count
       *  for AES3 / separate-mono layouts). 0 if no audio. Lets the UI build a channel selector
       *  at load time rather than waiting for audio to start. */
      audioChannelCount: number;
    }
  | { type: 'initSegment'; data: ArrayBuffer }
  | { type: 'videoInit'; codec: string; description: ArrayBuffer; width: number; height: number }
  | { type: 'videoChunk'; data: ArrayBuffer; timestamp: number; duration: number; keyframe: boolean }
  | { type: 'segmentDone' }
  | {
      /** A keyframe-only scrub preview fetch has finished (segment posted, or nothing to post —
       *  including when superseded). Drives the player's single-flight scrub pump so it fires the
       *  next preview at the latest dragged position. Always emitted so the pump can't deadlock. */
      type: 'previewDone';
      seq: number;
      /** Edit unit the preview actually represents (its GOP-head keyframe). The player seeks the
       *  playhead here to render it — this is what's buffered, not the mid-GOP dragged target. */
      editUnit: number;
    }
  | {
      type: 'videoSegment';
      data: ArrayBuffer;
      seq: number;
      editUnit: number;
      /**
       * Long-GOP only: the edit unit the next forward fetch should start at. The worker aligns each
       * Long-GOP fetch to whole GOPs (so per-GOP POC ranking is complete and segments tile), which
       * means it may cover more frames than requested; the player adopts this as `nextFetchFrame`
       * instead of its optimistic `+= frameCount`. Omitted for non-Long-GOP segments.
       */
      nextFrame?: number;
    }
  | { type: 'audioSegment'; data: ArrayBuffer; seq: number; editUnit: number }
  | { type: 'pcmSamples'; samples: Float32Array; editUnit: number; sampleRate: number; channelCount: number }
  | {
      type: 'seeked';
      nearestKeyframeEditUnit: number;
      /** Number of frames from the nearest keyframe to the next keyframe (GOP length; 1 for
       *  all-intra / CBE files). The player uses this to stretch an I-frame-only preview so it
       *  covers its whole GOP on the timeline. */
      gopFrameCount: number;
    }
  | { type: 'codecUnsupported'; codec: string; reason: string }
  | { type: 'error'; message: string; fatal: boolean };
