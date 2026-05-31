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
  /** Seeking strategy this file supports: 'cbg' | 'vbe' | 'none'. */
  indexMode: IndexMode;
}

export interface MxfPlayerEvents {
  manifest: ManifestData;
  error: { message: string; fatal: boolean };
  buffering: { bufferedSeconds: number };
  timeupdate: { currentTime: number; duration: number };
  playing: void;
  seeking: { targetTime: number };
  seeked: { actualTime: number };
  'codec-unsupported': { codec: string; reason: string };
  'pcm-audio': { samples: Float32Array; sampleRate: number; channelCount: number; editUnit: number };
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
