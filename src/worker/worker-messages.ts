import { MxfTrack } from '../parser/metadata.js';
import { PictureDescriptor, SoundDescriptor } from '../parser/descriptor.js';
import type { IndexMode } from '../mxf-file.js';

/**
 * A computed (header-metadata) package timecode for the manifest. `position` is the start frame
 * count (since 00:00:00:00); the running value for a rendered frame is `position + editUnit`.
 */
export interface ManifestTimecode {
  source: 'material' | 'file' | 'source';
  position: number;
  base: number;
  dropFrame: boolean;
  editRateNumerator: number;
  editRateDenominator: number;
}

/**
 * A per-frame System Item timecode anchor: at PRESENTATION edit unit `editUnit` the SMPTE timecode
 * is `frameCount` (absolute frame index), formatted at `base`/`dropFrame`. Only anchors that break
 * a linear run are sent, so a continuous-timecode segment carries one anchor; a discontinuity
 * ("jump") emits a fresh anchor. The player linearly interpolates between successive anchors.
 */
export interface TimecodeAnchor {
  editUnit: number;
  frameCount: number;
  base: number;
  dropFrame: boolean;
}

/** Plugin descriptor carried in init commands. Resolved on the main thread before posting. */
export interface WorkerPluginConfig {
  /** URL to the emscripten-generated .js factory (the .wasm is loaded automatically). */
  moduleUrl: string;
  /** FFmpeg codec name passed to dec_create(), e.g. 'mpeg2video', 'prores', 'mjpeg'. */
  ffmpegCodec: string;
  /**
   * The pd.codec value that triggers this plugin (e.g. 'mpeg2', 'h264', 'unknown').
   * Resolved from a built-in map on the main thread before the command is posted.
   */
  mxfCodec: string;
}

// Commands sent from main thread to worker
export type WorkerCommand =
  | { type: 'initUrl';  url: string;  debug?: boolean; videoMode?: 'webcodecs' | 'mse'; plugins?: { videoDecoder?: WorkerPluginConfig };
      /** Live mode: open as a growing recording — ignore the index, start at the file's end, stream
       *  forward. See MxfFile.openLive. */
      live?: boolean;
      /** Live mode: the continuous edit-unit counter to label this file's first emitted frame with,
       *  so a rotated next file's timestamps continue the previous file's timeline (seamless stitch). */
      startEditUnit?: number;
      /** Live mode: start reading from the essence container START rather than near EOF. False (the
       *  default) for the FIRST file (jump to its live edge); true for a rotated NEXT file, which just
       *  began recording so its beginning IS the live point and is contiguous with the previous file. */
      liveFromStart?: boolean }
  | { type: 'initFile'; file: File; debug?: boolean; videoMode?: 'webcodecs' | 'mse'; plugins?: { videoDecoder?: WorkerPluginConfig };
      live?: boolean; startEditUnit?: number; liveFromStart?: boolean }
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
    }
  | {
      /** Live mode: re-query the source size (refreshFileSize) and report whether it grew and whether
       *  the live reader has caught up to EOF. Drives the player's follow-the-edge poll loop. */
      type: 'pollLive';
    }
  | {
      /** Live mode: set the continuous edit-unit counter for the NEXT emitted frame, used at standby
       *  activation to lock a rotated file's timeline base to where the previous file ended. */
      type: 'setStartEditUnit';
      startEditUnit: number;
    }
  | {
      /** Live mode: drain the transcode decoder's held reorder frames at the file boundary. Mid-stream
       *  the pipeline holds its last reorder anchor (so video output trails the bytes the reader has
       *  consumed), which makes the video OUTPUT frontier lag the AUDIO frontier (audio isn't held). At
       *  a rotation those held frames would otherwise be lost and the next file's base (the video
       *  frontier) would sit BEHIND the audio already emitted → an A/V seam. flushLiveTail emits the
       *  held frames so the video frontier catches up to the audio frontier; the player then activates
       *  the standby from that aligned base. `seqBase` numbers the flushed video segment. */
      type: 'flushLiveTail';
      seqBase: number;
    };

// Events sent from worker to main thread
export type WorkerEvent =
  | {
      type: 'manifest';
      duration: number;  // in seconds
      editRateNumerator: number;
      editRateDenominator: number;
      tracks: MxfTrack[];
      /** Computed start timecodes from the Material / File / Source package timecode tracks. */
      timecodes: ManifestTimecode[];
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
      /** Live mode: this file was opened as a growing recording (index ignored, follow-the-edge). */
      live?: boolean;
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
      /** Per-frame System Item timecode anchors covering this segment's presentation edit units
       *  (sparse; absent when the file has no system-item timecode). */
      systemTcAnchors?: TimecodeAnchor[];
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
  | {
      /** Live mode: posted after every live fetch AND in answer to pollLive (replacing segmentDone for
       *  live). `grew` = new frames were produced / the source got larger; `atEdge` = the reader has
       *  caught up to the current EOF (no more complete frames right now); `nextEditUnit` = the
       *  continuous edit-unit counter the reader will next emit — the player adopts it as the
       *  authoritative forward-fetch frontier so it never over- or under-counts at the edge. */
      type: 'liveUpdate';
      grew: boolean;
      atEdge: boolean;
      /** The continuous OUTPUT frontier — the edit unit AFTER the last video frame actually emitted to
       *  MSE (display order, so it trails the bytes the reader has consumed by the transcode reorder
       *  depth). The player adopts it as the forward-fetch frontier and, at a file switch, as the next
       *  file's continuous base — so the seam is gap-free (the few un-emitted reorder frames at the end
       *  of the old file are dropped, which is imperceptible at a rotation boundary). */
      nextEditUnit: number;
    }
  | {
      /** Live mode: reply to flushLiveTail. The held reorder frames have been emitted (as a videoSegment
       *  posted just before this), and `nextEditUnit` is the now-aligned OUTPUT frontier (== the audio
       *  frontier). The player adopts it as `nextFetchFrame` and then activates the standby from it, so
       *  the next file's audio AND video both continue from the same edit unit (no A/V seam). */
      type: 'liveTailFlushed';
      nextEditUnit: number;
    }
  | { type: 'error'; message: string; fatal: boolean };
