import { MxfTrack } from './parser/metadata.js';
import { PictureDescriptor, SoundDescriptor } from './parser/descriptor.js';
import type { IndexMode } from './mxf-file.js';

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
}

export interface MxfPlayerEvents {
  manifest: ManifestData;
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
  playing: void;
  seeking: { targetTime: number };
  seeked: { actualTime: number };
  'codec-unsupported': { codec: string; reason: string };
  'pcm-audio': { samples: Float32Array; sampleRate: number; channelCount: number; editUnit: number };
  /** Fired when the PCM audio channel count is first known or changes — populate a channel selector. */
  'audio-info': { channelCount: number; activeChannels: number[] };
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
