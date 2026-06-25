import { MxfTrack } from './parser/metadata.js';
import { PictureDescriptor, SoundDescriptor } from './parser/descriptor.js';
import type { IndexMode } from './mxf-file.js';
import type { ManifestTimecode } from './worker/worker-messages.js';

export type { ManifestTimecode } from './worker/worker-messages.js';

/** Where a timecode came from: per-frame System Item, or a computed package start timecode. */
export type TimecodeSource = 'system' | 'material' | 'file' | 'source';

/**
 * The timecode(s) for the frame currently on screen. `primary` is the highest-priority available
 * (system → material → source → file); `all` lists every source with its formatted value and a
 * `reliable` flag (computed package timecodes are unreliable in 'none'/percentage index mode).
 */
export interface TimecodeBundle {
  editUnit: number;
  primary: { source: TimecodeSource; text: string } | null;
  all: { source: TimecodeSource; text: string; reliable: boolean }[];
}

export interface ManifestData {
  duration: number;
  editRateNumerator: number;
  editRateDenominator: number;
  tracks: MxfTrack[];
  pictureDescriptor: PictureDescriptor | null;
  soundDescriptor: SoundDescriptor | null;
  /**
   * Active picture dimensions to DISPLAY — the real frame size, not the descriptor's per-field
   * StoredHeight (e.g. 720×576, not 720×288). 0 when unknown. Pair with `aspectRatio` for the shape.
   */
  displayWidth: number;
  displayHeight: number;
  /**
   * Display aspect ratio (DAR) parsed from the MXF descriptor (e.g. `{num:16,den:9}`), or null for
   * square pixels. The picture is already rendered at this shape (a `pasp` box carries it into MSE);
   * this field lets the UI label it — e.g. show `${displayWidth}×${displayHeight}` plus `16:9`.
   */
  aspectRatio: { num: number; den: number } | null;
  /** Seeking strategy this file supports: 'cbg' | 'vbe' | 'none'. */
  indexMode: IndexMode;
  /** True for H.264 Long-GOP (XAVC-L) streams (B-frame reorder applied on fetch). */
  longGop: boolean;
  /**
   * The codec string the browser actually decodes — a precise `avc1.PPCCLL` (profile/constraints/
   * level, derived from the stream's SPS) for H.264 remux, or the transcoded H.264 string for MPEG-2.
   * Use it to build a `video/mp4; codecs="…"` contentType for `navigator.mediaCapabilities` so the
   * caller can ask whether THIS profile decodes power-efficiently (hardware) on the current machine —
   * e.g. High 4:2:2 (`avc1.7A…`) is hardware on Intel Quick Sync but software on many other GPUs.
   */
  resolvedVideoCodec: string;
  /** Computed start timecodes from the Material / File / Source package timecode tracks. */
  timecodes: ManifestTimecode[];
  /**
   * True when the file is being played as a growing live recording (loadLive). In live mode the
   * index is ignored, playback follows the file's end forward, there is no seeking/scrubbing, and
   * `duration` is not meaningful (it behaves like a live stream).
   */
  live?: boolean;
}

/**
 * A snapshot of player throughput + buffering, emitted on the `stats` event a couple of times a
 * second (and only while a file is loaded). Combines worker-side counters (network reads, encoder
 * backlog) with main-thread state (the MSE buffer and the fetch frontier) into one view a UI can
 * render directly. Byte counts are cumulative; `bandwidthBps` is the instantaneous download rate.
 */
export interface PlayerStats {
  /** Cumulative bytes downloaded/read since this file loaded. */
  bytesTotal: number;
  /** Instantaneous download rate (bytes/sec), measured from the byte-total delta between samples. */
  bandwidthBps: number;
  /** Range reads in flight right now (open HTTP fetches; 0 for a picked File — no network). */
  requestsInFlight: number;
  /** Cumulative completed reads. */
  requestsTotal: number;
  /**
   * Seconds of contiguous video buffered and PLAYABLE ahead of the playhead (post-encode, in MSE).
   * The green segment of a buffer bar. Saturates near `maxBufferSeconds`.
   */
  mseBufferedSeconds: number;
  /**
   * Seconds of media REQUESTED ahead of the playhead (the fetch frontier minus the playhead). Always
   * ≥ `mseBufferedSeconds`; the excess is in flight / decoding / encoding but not yet playable — the
   * amber segment of a buffer bar.
   */
  requestedAheadSeconds: number;
  /** Forward buffer target the player fetches up to (the bar's max). */
  maxBufferSeconds: number;
  /** Frames queued in the encoder (decoded YUV awaiting encode). MPEG-2/transcode path only; 0 else. */
  encodeQueueSize: number;
  /** True when video is being transcoded (MPEG-2 decode→encode); false for the H.264 remux path. */
  transcoding: boolean;
  /**
   * Raw (compressed) source bytes currently held by the worker-side source cache — see
   * {@link MxfConfig.maxSourceCacheBytes}. This is the SOURCE essence already fetched and kept so
   * backward seeks don't re-download; distinct from `mseBufferedSeconds` (decoded fMP4). `0` when the
   * cache is disabled or in live mode.
   */
  sourceCacheBytes: number;
  /** The source cache's byte budget (`maxSourceCacheBytes`); the cache bar's max. `0` when off/live. */
  sourceCacheMaxBytes: number;
}

export interface MxfPlayerEvents {
  manifest: ManifestData;
  /**
   * Periodic throughput + buffering telemetry for a stats UI — see {@link PlayerStats}. Emitted a
   * couple of times a second while a file is loaded; never between loads. Purely informational
   * (driving it has no effect on playback).
   */
  stats: PlayerStats;
  error: { message: string; fatal: boolean };
  /**
   * Fired when the player's buffering STATE changes (not on every tick). `buffering: true` means
   * playback is held/stalled waiting for more data — the first picture may already be visible, but
   * the playhead is not advancing — so the UI should show a "Buffering…" indicator. `buffering:
   * false` means playback is running (or able to). `bufferedSeconds` is the buffered-ahead amount at
   * the moment of the transition.
   */
  buffering: { buffering: boolean; bufferedSeconds: number };
  timeupdate: { currentTime: number; duration: number };
  /**
   * Fired when the timecode of the frame on screen changes (driven by requestVideoFrameCallback
   * where available, else by timeupdate). Carries the per-frame System Item timecode and the
   * computed package timecodes — see {@link TimecodeBundle}. Always matches the rendered frame.
   */
  timecode: TimecodeBundle;
  playing: void;
  seeking: { targetTime: number };
  seeked: { actualTime: number };
  'codec-unsupported': { codec: string; reason: string };
  'pcm-audio': { samples: Float32Array; sampleRate: number; channelCount: number; editUnit: number };
  /** Fired when the PCM audio channel count is first known or changes — populate a channel selector. */
  'audio-info': { channelCount: number; activeChannels: number[] };
  /**
   * Live mode: the current file is complete (recording finished / rotated) and playback has reached
   * its end. The consumer should call `switchLive(nextUrl)` (or `preloadNextUrl` ahead of time) to
   * continue with the next file in the playlist. Never fired for non-live playback.
   */
  'live-end': void;
  /**
   * Live mode: a gapless hand-off to the next rotated file just completed (same MSE/audio, no
   * teardown). `url` is the file now playing. The consumer updates its "current file" bookkeeping
   * here instead of re-anchoring. Fired by switchLive/preloadNextUrl-driven rotation, not by loadLive.
   */
  'live-switched': { url: string };
  /**
   * Live mode: catch-up speed state changed. `active: true` means the player has nudged playback
   * above 1× to drain accumulated lag and close the gap to the live edge (audio pitches up slightly
   * while active); `active: false` means it has restored normal speed. `rate` is the playback rate
   * now in effect, `lagSeconds` the estimated lag at the transition. UI can show a "catching up…"
   * hint. Only fired for the 'speed' catch-up strategy.
   */
  catchup: { active: boolean; rate: number; lagSeconds: number };
  /**
   * Live mode: the player has fallen too far behind the live edge to close smoothly and is
   * requesting a hard re-anchor to the edge. The player cannot name files, so the consumer responds
   * by calling `reanchorLive(newestUrl)` with the newest file from its playlist. `lagSeconds` is the
   * estimated lag that triggered it. Fired by the 'jump' strategy and as the 'speed' strategy's
   * large-lag fallback.
   */
  'catchup-jump': { lagSeconds: number };
  destroyed: void;
}

export type EventListener<T> = (data: T) => void;

export class EventEmitter<Events extends object> {
  private listeners = new Map<string, Set<EventListener<unknown>>>();

  on<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): this {
    const key = String(event);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(listener as EventListener<unknown>);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): this {
    this.listeners.get(String(event))?.delete(listener as EventListener<unknown>);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): this {
    const wrapper: EventListener<Events[K]> = (data) => {
      listener(data);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  protected emit<K extends keyof Events>(event: K, data: Events[K]): void {
    this.listeners.get(String(event))?.forEach(l => {
      try { l(data); } catch { /* isolate listener errors */ }
    });
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
