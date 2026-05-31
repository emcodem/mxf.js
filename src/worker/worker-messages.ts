import { MxfTrack } from '../parser/metadata.js';
import { PictureDescriptor, SoundDescriptor } from '../parser/descriptor.js';

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
  | { type: 'seek'; targetFrame: number };

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
      videoCodecSupported: boolean;
      pcmMseSupported: boolean;
      /** Codec the worker will actually deliver to MSE (may differ from pictureDescriptor.codec). */
      resolvedVideoCodec: string;
      /** Whether the worker will use MSE segments or WebCodecs chunks for video. */
      resolvedVideoMode: 'mse' | 'webcodecs';
    }
  | { type: 'initSegment'; data: ArrayBuffer }
  | { type: 'videoInit'; codec: string; description: ArrayBuffer; width: number; height: number }
  | { type: 'videoChunk'; data: ArrayBuffer; timestamp: number; duration: number; keyframe: boolean }
  | { type: 'segmentDone' }
  | { type: 'videoSegment'; data: ArrayBuffer; seq: number; editUnit: number }
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
