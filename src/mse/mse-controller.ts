export type TrackType = 'video' | 'audio';

interface AppendTask {
  trackType: TrackType;
  data: ArrayBuffer;
}

export class MseController {
  private readonly video: HTMLVideoElement;
  private mediaSource: MediaSource | null = null;
  private objectURL: string | null = null;
  private sourceBuffers = new Map<TrackType, SourceBuffer>();
  private appendQueues = new Map<TrackType, AppendTask[]>();
  private processing = new Map<TrackType, boolean>();
  onError: ((type: TrackType, message: string) => void) | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
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
    console.log(`[mse] addSourceBuffer ${type} "${mimeType}"`);
    const sb = this.mediaSource!.addSourceBuffer(mimeType);
    this.sourceBuffers.set(type, sb);
    this.appendQueues.set(type, []);
    this.processing.set(type, false);

    sb.addEventListener('updateend', () => {
      this.processing.set(type, false);
      this.drainQueue(type);
    });
    sb.addEventListener('error', () => {
      const msg = `SourceBuffer error on ${type} track — codec may be unsupported or data is malformed`;
      console.error(`[jsmxf] ${msg}`);
      this.onError?.(type, msg);
    });
  }

  appendSegment(trackType: TrackType, data: ArrayBuffer): void {
    const queue = this.appendQueues.get(trackType);
    if (!queue) return; // SourceBuffer not created (codec not supported)
    const u8 = new Uint8Array(data, 0, Math.min(12, data.byteLength));
    console.log(`[mse] appendSegment ${trackType} ${data.byteLength}b first bytes:`, Array.from(u8).map(b=>b.toString(16).padStart(2,'0')).join(' '));
    queue.push({ trackType, data });
    this.drainQueue(trackType);
  }

  private drainQueue(type: TrackType): void {
    if (this.processing.get(type)) return;
    const queue = this.appendQueues.get(type);
    const sb = this.sourceBuffers.get(type);
    if (!queue || !sb || queue.length === 0) return;
    if (sb.updating) return;

    const task = queue.shift()!;
    this.processing.set(type, true);
    try {
      sb.appendBuffer(task.data);
    } catch (e) {
      this.processing.set(type, false);
      console.error(`appendBuffer error (${type}):`, e);
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
    this.appendQueues.clear();
  }
}
