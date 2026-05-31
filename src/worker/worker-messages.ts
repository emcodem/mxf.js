import { MxfTrack } from '../parser/metadata.js';
import { PictureDescriptor, SoundDescriptor } from '../parser/descriptor.js';

// Commands sent from main thread to worker
export type WorkerCommand =
  | { type: 'initUrl'; url: string; debug?: boolean; videoMode?: 'webcodecs' | 'mse' }
  | { type: 'initFile'; file: File; debug?: boolean; videoMode?: 'webcodecs' | 'mse' }
  | { type: 'fetchSegment'; startFrame: number; frameCount: number; seqBase: number }
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
  | { type: 'seeked'; nearestKeyframeEditUnit: number }
  | { type: 'codecUnsupported'; codec: string; reason: string }
  | { type: 'error'; message: string; fatal: boolean };
