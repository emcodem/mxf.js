import { BACK_BUFFER_SECONDS } from '../core/constants.js';
import { EventEmitter } from '../events.js';

export type TrackType = 'video' | 'audio';

export interface MseControllerEvents {
  /** A SourceBuffer error on a track — codec may be unsupported or the data malformed. */
  error: { track: TrackType; message: string };
  /** An append failed with QuotaExceededError and no behind-playhead data can be freed, i.e. the
   *  forward buffer is full — the player should stop fetching until the playhead advances. */
  bufferfull: void;
}

type QueueOp =
  | { kind: 'append'; data: ArrayBuffer }
  | { kind: 'remove'; start: number; end: number };

export class MseController extends EventEmitter<MseControllerEvents> {
  private readonly video: HTMLVideoElement;
  private mediaSource: MediaSource | null = null;
  private objectURL: string | null = null;
  private sourceBuffers = new Map<TrackType, SourceBuffer>();
  private queues = new Map<TrackType, QueueOp[]>();
  private processing = new Map<TrackType, boolean>();
  private readonly debug: boolean;

  constructor(video: HTMLVideoElement, debug = false) {
    super();
    this.video = video;
    this.debug = debug;
  }

  open(videoMimeType: string | null, audioMimeType: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
      this.mediaSource = new MediaSource();
      this.objectURL = URL.createObjectURL(this.mediaSource);
      this.video.src = this.objectURL;

      this.mediaSource.addEventListener('sourceopen', () => {
        try {
          if (videoMimeType && MediaSource.isTypeSupported(videoMimeType)) {
            this.addSourceBuffer('video', videoMimeType);
          }
          if (audioMimeType && MediaSource.isTypeSupported(audioMimeType)) {
            this.addSourceBuffer('audio', audioMimeType);
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      }, { once: true });

      this.mediaSource.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
    });
  }

  private addSourceBuffer(type: TrackType, mimeType: string): void {
    if (this.debug) console.log(`[mse] addSourceBuffer ${type} "${mimeType}"`);
    const sb = this.mediaSource!.addSourceBuffer(mimeType);
    this.sourceBuffers.set(type, sb);
    this.queues.set(type, []);
    this.processing.set(type, false);

    sb.addEventListener('updateend', () => {
      this.processing.set(type, false);
      this.drainQueue(type);
    });
    sb.addEventListener('error', () => {
      const msg = `SourceBuffer error on ${type} track — codec may be unsupported or data is malformed`;
      console.error(`[jsmxf] ${msg}`);
      this.emit('error', { track: type, message: msg });
    });
  }

  appendSegment(trackType: TrackType, data: ArrayBuffer): void {
    const queue = this.queues.get(trackType);
    if (!queue) return; // SourceBuffer not created (codec not supported)
    queue.push({ kind: 'append', data });
    this.drainQueue(trackType);
  }

  /** Queue a removal of buffered media in [start, end) for a track (used to cap buffer growth). */
  evict(trackType: TrackType, start: number, end: number): void {
    const queue = this.queues.get(trackType);
    if (!queue || end <= start) return;
    queue.push({ kind: 'remove', start, end });
    this.drainQueue(trackType);
  }

  /**
   * Evict already-played media older than `BACK_BUFFER_SECONDS` behind `currentTime` on every track,
   * keeping the resident buffer bounded. Called as playback advances. No-op if there's nothing old
   * enough to remove.
   */
  trimBackBuffer(currentTime: number): void {
    const cutoff = currentTime - BACK_BUFFER_SECONDS;
    if (cutoff <= 0) return;
    for (const [type, sb] of this.sourceBuffers) {
      if (sb.buffered.length === 0) continue;
      const start = sb.buffered.start(0);
      if (cutoff > start + 0.5) this.evict(type, start, cutoff);
    }
  }

  private drainQueue(type: TrackType): void {
    if (this.processing.get(type)) return;
    const queue = this.queues.get(type);
    const sb = this.sourceBuffers.get(type);
    if (!queue || !sb || queue.length === 0) return;
    if (sb.updating) return;

    const op = queue[0];
    this.processing.set(type, true);
    try {
      if (op.kind === 'append') {
        queue.shift();
        sb.appendBuffer(op.data);
      } else {
        queue.shift();
        // Clamp to the actual buffered extent so remove() never throws on an empty/short range.
        const bufStart = sb.buffered.length ? sb.buffered.start(0) : op.start;
        const bufEnd = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : op.end;
        const s = Math.max(op.start, bufStart);
        const e = Math.min(op.end, bufEnd);
        if (e > s) { sb.remove(s, e); } else { this.processing.set(type, false); this.drainQueue(type); }
      }
    } catch (e) {
      this.processing.set(type, false);
      if (op.kind === 'append' && (e as DOMException)?.name === 'QuotaExceededError') {
        this.handleQuota(type, op.data);
      } else {
        console.error(`appendBuffer error (${type}):`, e);
      }
    }
  }

  /**
   * The SourceBuffer is full. Free space by evicting media behind the playhead and retry the append.
   * If there's nothing behind to evict (the forward buffer alone is over quota — common for
   * high-bitrate all-intra like AVC-Intra), the segment can't be appended now: re-queue it at the
   * front and tell the player to stop fetching until the playhead advances and frees room.
   */
  private handleQuota(type: TrackType, data: ArrayBuffer): void {
    const sb = this.sourceBuffers.get(type);
    const queue = this.queues.get(type);
    if (!sb || !queue) return;
    queue.unshift({ kind: 'append', data }); // retry this append after we make room

    const ct = this.video.currentTime;
    const cutoff = ct - 2; // keep a little behind the playhead; drop the rest
    const start = sb.buffered.length ? sb.buffered.start(0) : 0;
    if (sb.buffered.length > 0 && cutoff > start + 0.5) {
      // There is removable behind-playhead data — evict it, then the retry append runs on updateend.
      queue.unshift({ kind: 'remove', start, end: cutoff });
      this.drainQueue(type);
    } else {
      // Forward buffer is full and nothing behind to drop. Hold the append; the player must pause
      // fetching. trimBackBuffer() (as currentTime advances) will free room and drain the held op.
      if (this.debug) console.warn(`[mse] ${type} buffer full — pausing fetch until playhead advances`);
      this.emit('bufferfull', undefined as unknown as void);
    }
  }

  setDuration(seconds: number): void {
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.duration = seconds;
      } catch {
        // Ignore if not settable (e.g., during append)
      }
    }
  }

  endOfStream(): void {
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      // Wait for all source buffers to finish
      const checkAndEnd = () => {
        const updating = [...this.sourceBuffers.values()].some(sb => sb.updating);
        if (updating) {
          setTimeout(checkAndEnd, 50);
        } else {
          try { this.mediaSource!.endOfStream(); } catch { /* ignore */ }
        }
      };
      checkAndEnd();
    }
  }

  /** Returns the current buffered end time in seconds for a given track */
  getBufferedEnd(type: TrackType): number {
    const sb = this.sourceBuffers.get(type);
    if (!sb || sb.buffered.length === 0) return 0;
    return sb.buffered.end(sb.buffered.length - 1);
  }

  /**
   * Seconds of media buffered contiguously starting at `time`. Unlike getBufferedEnd this is
   * range-aware: if `time` is not inside any buffered range it returns 0 (data is needed here
   * now), and if it is, it returns the end of *that* range — not the end of some unrelated
   * later range. This is what fetch scheduling must use, otherwise a seek into an unbuffered
   * gap while a far-ahead range exists looks "buffered" and never fetches → permanent stall.
   */
  getBufferedAhead(type: TrackType, time: number): number {
    const sb = this.sourceBuffers.get(type);
    if (!sb || sb.buffered.length === 0) return 0;
    for (let i = 0; i < sb.buffered.length; i++) {
      const start = sb.buffered.start(i);
      const end = sb.buffered.end(i);
      // Small tolerance so a seek that lands a hair before a range start still counts.
      if (time >= start - 0.25 && time < end) return end - time;
    }
    return 0;
  }

  /** Returns the current buffered start time in seconds for a given track */
  getBufferedStart(type: TrackType): number {
    const sb = this.sourceBuffers.get(type);
    if (!sb || sb.buffered.length === 0) return 0;
    return sb.buffered.start(0);
  }

  hasVideoBuffer(): boolean { return this.sourceBuffers.has('video'); }
  hasAudioBuffer(): boolean { return this.sourceBuffers.has('audio'); }

  static isVideoTypeSupported(codec: 'h264' | 'mpeg2'): boolean {
    if (codec === 'h264') {
      return MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
    }
    return MediaSource.isTypeSupported('video/mp4; codecs="mp4v.20.2"');
  }

  static isAudioTypeSupported(codec: 'pcm' | 'aac'): boolean {
    if (codec === 'aac') {
      return MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
    }
    // PCM in MSE: ipcm (Chrome 95+), otherwise fallback to Web Audio
    return MediaSource.isTypeSupported('audio/mp4; codecs="ipcm"') ||
           MediaSource.isTypeSupported('audio/mp4; codecs="sowt"');
  }

  static getMimeType(trackType: TrackType, codec: string): string | null {
    if (trackType === 'video') {
      if (codec === 'h264' || codec.startsWith('avc1.')) {
        // Accept either the short name 'h264' (use a permissive default) or a
        // full codec string like 'avc1.4d4032' derived from the actual SPS bytes.
        const codecStr = codec.startsWith('avc1.') ? codec : 'avc1.640033';
        return `video/mp4; codecs="${codecStr}"`;
      }
      if (codec === 'mpeg2') return 'video/mp4; codecs="mp4v.20.2"';
    }
    if (trackType === 'audio') {
      if (codec === 'aac') return 'audio/mp4; codecs="mp4a.40.2"';
      if (codec === 'pcm') {
        if (MediaSource.isTypeSupported('audio/mp4; codecs="ipcm"')) return 'audio/mp4; codecs="ipcm"';
        if (MediaSource.isTypeSupported('audio/mp4; codecs="sowt"')) return 'audio/mp4; codecs="sowt"';
        return null; // Will use Web Audio API
      }
    }
    return null;
  }

  destroy(): void {
    if (this.objectURL) {
      URL.revokeObjectURL(this.objectURL);
      this.objectURL = null;
    }
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch { /* ignore */ }
    }
    this.video.src = '';
    this.mediaSource = null;
    this.sourceBuffers.clear();
    this.queues.clear();
    this.removeAllListeners();
  }
}
