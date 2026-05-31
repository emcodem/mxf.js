import { EventEmitter, MxfPlayerEvents, ManifestData } from './events.js';
import { MseController } from './mse/mse-controller.js';
import { WorkerCommand, WorkerEvent } from './worker/worker-messages.js';

export interface MxfConfig {
  /** Seconds of content to buffer before starting playback */
  startBufferSeconds?: number;
  /** Maximum seconds to buffer ahead of current position */
  maxBufferSeconds?: number;
  /** How to handle PCM audio: 'mse' (if supported), 'webaudio', or 'auto' */
  pcmAudioMode?: 'mse' | 'webaudio' | 'auto';
  debug?: boolean;
}

const DEFAULT_CONFIG: Required<MxfConfig> = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: 'auto',
  debug: false,
};

export class MxfPlayer extends EventEmitter<MxfPlayerEvents> {
  private readonly video: HTMLVideoElement;
  private readonly config: Required<MxfConfig>;
  private worker: Worker | null = null;
  private mseController: MseController | null = null;
  private manifest: ManifestData | null = null;
  private audioCxt: AudioContext | null = null;
  private useWebAudio = false;
  private nextFetchFrame = 0;
  private framesPerChunk = 50;   // fetch ~2 seconds at 25fps
  private fetchPending = false;
  private editRateNumerator = 25;
  private editRateDenominator = 1;
  private seqBase = 0;
  private pendingInitSegment: ArrayBuffer | null = null;
  // WebCodecs path
  private webCodecsMode = false;
  private videoDecoder: VideoDecoder | null = null;
  private webCodecsCanvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private frameQueue: Array<{ frame: VideoFrame; pts: number }> = [];
  private rafId: number | null = null;
  private webCodecsBufferedEnd = 0;
  private audioStartTime: number | null = null;
  private lastTimeupdateEmit = -1;

  constructor(video: HTMLVideoElement, config: MxfConfig = {}) {
    super();
    this.video = video;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.video.addEventListener('seeking', () => this.onVideoSeeking());
    this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
  }

  get currentTime(): number {
    return this.webCodecsMode ? this.getCurrentTime() : this.video.currentTime;
  }

  get duration(): number {
    return this.manifest?.duration ?? 0;
  }

  get paused(): boolean {
    return this.webCodecsMode ? this.audioCxt?.state !== 'running' : this.video.paused;
  }

  play(): void {
    if (this.webCodecsMode) {
      this.audioCxt?.resume().catch(() => {});
    } else {
      this.video.play().catch(() => {});
    }
  }

  pause(): void {
    if (this.webCodecsMode) {
      this.audioCxt?.suspend().catch(() => {});
    } else {
      this.video.pause();
    }
  }

  loadUrl(url: string): void {
    this.setup();
    const preferredMode: 'webcodecs' | 'mse' = typeof VideoDecoder !== 'undefined' ? 'webcodecs' : 'mse';
    const cmd: WorkerCommand = { type: 'initUrl', url, debug: this.config.debug, videoMode: preferredMode };
    this.worker!.postMessage(cmd);
  }

  loadFile(file: File): void {
    this.setup();
    const preferredMode: 'webcodecs' | 'mse' = typeof VideoDecoder !== 'undefined' ? 'webcodecs' : 'mse';
    const cmd: WorkerCommand = { type: 'initFile', file, debug: this.config.debug, videoMode: preferredMode };
    this.worker!.postMessage(cmd);
  }

  private setup(): void {
    this.destroyInternal();
    // Defer mode decision until manifest arrives — worker may override (e.g. MPEG-2 transcode).
    this.webCodecsMode = false;
    this.worker = this.createWorker();
    this.worker.addEventListener('message', (e: MessageEvent<WorkerEvent>) => this.onWorkerMessage(e.data));
    this.worker.addEventListener('error', (e) => {
      this.emit('error', { message: e.message ?? 'Worker error', fatal: true });
    });
    // Always create MSE controller; onManifest decides whether to open it.
    this.mseController = new MseController(this.video);
    this.mseController.onError = (type, message) => {
      this.emit('error', { message: `MSE ${type}: ${message}`, fatal: false });
    };
  }

  private createWorker(): Worker {
    // Worker source is inlined at build time via Rollup
    // In development, import the worker as a module URL
    const workerUrl = new URL('./worker/demux-worker.ts', import.meta.url);
    return new Worker(workerUrl, { type: 'module' });
  }

  private async onWorkerMessage(event: WorkerEvent): Promise<void> {
    switch (event.type) {
      case 'manifest':
        await this.onManifest(event);
        break;

      case 'initSegment':
        if (!this.webCodecsMode) {
          if (this.mseController?.hasVideoBuffer() || this.mseController?.hasAudioBuffer()) {
            // MSE is already open — append directly and start fetching.
            this.mseController.appendSegment('video', event.data);
            this.mseController.appendSegment('audio', event.data);
            this.fetchNextChunk();
          } else {
            // MSE not ready yet (sourceopen race) — store for onManifest to flush.
            this.pendingInitSegment = event.data;
          }
        }
        break;

      case 'videoInit':
        this.onVideoInit(event);
        break;

      case 'videoChunk':
        this.onVideoChunk(event);
        break;

      case 'segmentDone':
        if (this.webCodecsMode) {
          this.fetchPending = false;
          // rAF loop triggers fetchNextChunk when buffer runs low
        }
        break;

      case 'videoSegment':
        this.mseController?.appendSegment('video', event.data);
        // For video-only files (no audio MSE buffer and no Web Audio path),
        // the video segment is the last response — trigger next fetch here.
        if (!this.useWebAudio && !this.mseController?.hasAudioBuffer()) {
          this.fetchPending = false;
          this.fetchNextChunk();
        }
        break;

      case 'audioSegment':
        this.mseController?.appendSegment('audio', event.data);
        // Audio segment is the last response for a video+audio chunk.
        this.fetchPending = false;
        this.fetchNextChunk();
        break;

      case 'pcmSamples':
        this.emit('pcm-audio', {
          samples: event.samples,
          sampleRate: event.sampleRate,
          channelCount: event.channelCount,
          editUnit: event.editUnit,
        });
        this.schedulePCMAudio(event.samples, event.sampleRate, event.channelCount, event.editUnit);
        // PCM samples are the last response for a video+PCM-audio chunk.
        this.fetchPending = false;
        this.fetchNextChunk();
        break;

      case 'seeked':
        this.nextFetchFrame = event.nearestKeyframeEditUnit;
        this.fetchPending = false;
        this.fetchNextChunk();
        break;

      case 'codecUnsupported':
        this.emit('codec-unsupported', { codec: event.codec, reason: event.reason });
        break;

      case 'error':
        this.emit('error', { message: event.message, fatal: event.fatal });
        break;
    }
  }

  private async onManifest(event: Extract<WorkerEvent, { type: 'manifest' }>): Promise<void> {
    const pd = event.pictureDescriptor;
    const sd = event.soundDescriptor;

    this.editRateNumerator = event.editRateNumerator;
    this.editRateDenominator = event.editRateDenominator;

    const fps = event.editRateNumerator / event.editRateDenominator;
    this.framesPerChunk = Math.ceil(fps * 2); // ~2 second chunks

    this.manifest = {
      duration: event.duration,
      editRateNumerator: event.editRateNumerator,
      editRateDenominator: event.editRateDenominator,
      tracks: event.tracks,
      pictureDescriptor: pd,
      soundDescriptor: sd,
    };

    // Worker decides mode; fall back to client-side VideoDecoder check for older workers.
    const resolvedMode = event.resolvedVideoMode ?? (typeof VideoDecoder !== 'undefined' ? 'webcodecs' : 'mse');
    this.webCodecsMode = resolvedMode === 'webcodecs';

    if (this.webCodecsMode) {
      // WebCodecs path: setup audio only. Video is initialized via the videoInit event.
      if (sd?.codec === 'pcm') {
        this.useWebAudio = true;
        this.audioCxt = new AudioContext({ sampleRate: sd.sampleRate });
      }
      this.emit('manifest', this.manifest);
      this.log(`Manifest: ${event.duration.toFixed(2)}s, video=${pd?.codec} (WebCodecs), audio=${sd?.codec}`);
      return;
    }

    // MSE path — use the resolved output codec for MIME type (e.g. 'h264' for transcoded MPEG-2)
    const effectiveVideoCodec = event.resolvedVideoCodec ?? pd?.codec ?? 'unknown';
    const videoMime = (pd && event.videoCodecSupported)
      ? MseController.getMimeType('video', effectiveVideoCodec)
      : null;
    let audioMime = sd ? MseController.getMimeType('audio', sd.codec) : null;

    if (sd?.codec === 'pcm') {
      if (this.config.pcmAudioMode === 'webaudio' || !audioMime) {
        this.useWebAudio = true;
        audioMime = null;
        this.audioCxt = new AudioContext({ sampleRate: sd.sampleRate });
      }
    }

    try {
      await this.mseController!.open(videoMime, audioMime);
    } catch (e) {
      this.emit('error', { message: `MSE open failed: ${e}`, fatal: true });
      return;
    }

    this.mseController!.setDuration(event.duration);

    // Flush init segment if it arrived before sourceopen (the other ordering is
    // handled in the initSegment case above — it appends directly and calls fetchNextChunk).
    if (this.pendingInitSegment) {
      this.mseController?.appendSegment('video', this.pendingInitSegment);
      this.mseController?.appendSegment('audio', this.pendingInitSegment);
      this.pendingInitSegment = null;
      this.emit('manifest', this.manifest);
      this.log(`Manifest: ${event.duration.toFixed(2)}s, video=${pd?.codec}, audio=${sd?.codec}`);
      this.fetchNextChunk();
    } else {
      this.emit('manifest', this.manifest);
      this.log(`Manifest: ${event.duration.toFixed(2)}s, video=${pd?.codec}, audio=${sd?.codec}`);
    }
  }

  private onVideoInit(event: Extract<WorkerEvent, { type: 'videoInit' }>): void {
    this.videoDecoder = new VideoDecoder({
      output: (frame) => {
        this.frameQueue.push({ frame, pts: frame.timestamp / 1_000_000 });
      },
      error: (e) => {
        this.emit('error', { message: `VideoDecoder: ${e.message}`, fatal: false });
      },
    });

    try {
      this.videoDecoder.configure({
        codec: event.codec,
        description: new Uint8Array(event.description),
        codedWidth: event.width,
        codedHeight: event.height,
        optimizeForLatency: false,
      });
    } catch (e) {
      this.emit('error', { message: `WebCodecs configure failed: ${e}`, fatal: true });
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = event.width;
    canvas.height = event.height;
    canvas.style.cssText = 'width:100%;max-width:960px;display:block;border-radius:8px;margin-bottom:16px;background:#000';
    this.video.parentNode?.insertBefore(canvas, this.video);
    this.video.style.display = 'none';
    this.webCodecsCanvas = canvas;
    this.canvasCtx = canvas.getContext('2d');

    if (this.audioCxt) {
      this.audioStartTime = this.audioCxt.currentTime;
    }
    this.startRenderLoop();
    this.fetchNextChunk();
  }

  private onVideoChunk(event: Extract<WorkerEvent, { type: 'videoChunk' }>): void {
    if (!this.videoDecoder || this.videoDecoder.state !== 'configured') return;
    try {
      this.videoDecoder.decode(new EncodedVideoChunk({
        type: event.keyframe ? 'key' : 'delta',
        timestamp: event.timestamp,
        duration: event.duration,
        data: new Uint8Array(event.data),
      }));
    } catch (e) {
      this.emit('error', { message: `VideoDecoder decode: ${e}`, fatal: false });
    }
    this.webCodecsBufferedEnd = (event.timestamp + event.duration) / 1_000_000;
  }

  private startRenderLoop(): void {
    const loop = () => {
      this.renderFrame();
      if (!this.fetchPending && this.manifest) {
        const now = this.getCurrentTime();
        if (this.webCodecsBufferedEnd - now < this.config.startBufferSeconds) {
          this.fetchNextChunk();
        }
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private renderFrame(): void {
    if (!this.canvasCtx || !this.webCodecsCanvas || this.frameQueue.length === 0) return;
    const now = this.getCurrentTime();
    const frameDur = this.editRateDenominator / this.editRateNumerator;

    if (now - this.lastTimeupdateEmit >= 0.25) {
      this.lastTimeupdateEmit = now;
      this.emit('timeupdate', { currentTime: now, duration: this.duration });
    }

    // Drop frames that playback has passed, keeping the most recent renderable one
    while (this.frameQueue.length > 1 && this.frameQueue[1].pts <= now) {
      this.frameQueue.shift()!.frame.close();
    }

    if (this.frameQueue[0].pts <= now + frameDur) {
      this.canvasCtx.drawImage(this.frameQueue[0].frame, 0, 0, this.webCodecsCanvas.width, this.webCodecsCanvas.height);
    }
  }

  private getCurrentTime(): number {
    if (!this.audioCxt || this.audioStartTime === null) return 0;
    return this.audioCxt.currentTime - this.audioStartTime;
  }

  private fetchNextChunk(): void {
    if (this.fetchPending || !this.manifest) return;

    const bufferedEnd = this.webCodecsMode ? this.webCodecsBufferedEnd : (this.mseController?.getBufferedEnd('video') ?? 0);
    const currentTime = this.webCodecsMode ? this.getCurrentTime() : this.video.currentTime;
    const aheadSeconds = bufferedEnd - currentTime;

    if (aheadSeconds >= this.config.maxBufferSeconds) return;

    const totalFrames = Math.round(
      this.manifest.duration * this.editRateNumerator / this.editRateDenominator
    );
    if (this.nextFetchFrame >= totalFrames) {
      if (!this.webCodecsMode) this.mseController?.endOfStream();
      return;
    }

    this.fetchPending = true;
    const cmd: WorkerCommand = {
      type: 'fetchSegment',
      startFrame: this.nextFetchFrame,
      frameCount: this.framesPerChunk,
      seqBase: this.seqBase,
    };
    this.seqBase += 2;
    this.nextFetchFrame += this.framesPerChunk;
    this.worker!.postMessage(cmd);
  }

  private onVideoSeeking(): void {
    if (this.webCodecsMode) return; // seeking not implemented for WebCodecs path yet
    const targetTime = this.video.currentTime;
    this.emit('seeking', { targetTime });
    this.fetchPending = true; // pause fetching until worker responds

    const targetFrame = Math.round(
      targetTime * this.editRateNumerator / this.editRateDenominator
    );
    this.nextFetchFrame = targetFrame;

    const cmd: WorkerCommand = { type: 'seek', targetFrame };
    this.worker!.postMessage(cmd);
  }

  private onTimeUpdate(): void {
    if (!this.manifest || this.webCodecsMode) return;
    const bufferedEnd = this.mseController?.getBufferedEnd('video') ?? 0;
    const currentTime = this.video.currentTime;
    const aheadSeconds = bufferedEnd - currentTime;

    if (aheadSeconds < this.config.startBufferSeconds) {
      this.fetchNextChunk();
    }

    this.emit('buffering', { bufferedSeconds: aheadSeconds });
    this.emit('timeupdate', { currentTime, duration: this.duration });
  }

  private schedulePCMAudio(
    samples: Float32Array,
    sampleRate: number,
    channelCount: number,
    editUnit: number
  ): void {
    if (!this.audioCxt) return;

    const cxt = this.audioCxt;
    const samplesPerChannel = Math.floor(samples.length / channelCount);
    const audioBuffer = cxt.createBuffer(channelCount, samplesPerChannel, sampleRate);

    // De-interleave
    for (let ch = 0; ch < channelCount; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < samplesPerChannel; i++) {
        channelData[i] = samples[i * channelCount + ch];
      }
    }

    const source = cxt.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(cxt.destination);

    const startSec = editUnit * this.editRateDenominator / this.editRateNumerator;

    // Anchor: record the AudioContext time at which presentation time 0 plays.
    // Works for both MSE+PCM (video.currentTime unreliable until video plays) and WebCodecs.
    if (this.audioStartTime === null) {
      this.audioStartTime = cxt.currentTime - startSec;
    }
    const audioTime = this.audioStartTime + startSec;
    // If we're already past this point (e.g. late delivery), play immediately.
    source.start(Math.max(cxt.currentTime, audioTime));
  }

  private log(msg: string): void {
    if (this.config.debug) console.log('[jsmxf]', msg);
  }

  private destroyInternal(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    for (const { frame } of this.frameQueue) frame.close();
    this.frameQueue = [];
    try { this.videoDecoder?.close(); } catch (_) { /* ignore if already closed */ }
    this.videoDecoder = null;
    this.webCodecsCanvas?.remove();
    this.webCodecsCanvas = null;
    this.canvasCtx = null;
    if (this.video.style.display === 'none') this.video.style.display = '';
    this.webCodecsMode = false;
    this.webCodecsBufferedEnd = 0;
    this.audioStartTime = null;
    this.lastTimeupdateEmit = -1;
    this.worker?.terminate();
    this.worker = null;
    this.mseController?.destroy();
    this.mseController = null;
    this.audioCxt?.close().catch(() => {});
    this.audioCxt = null;
    this.manifest = null;
    this.nextFetchFrame = 0;
    this.fetchPending = false;
    this.seqBase = 0;
    this.pendingInitSegment = null;
    this.useWebAudio = false;
  }

  destroy(): void {
    this.destroyInternal();
    this.removeAllListeners();
    this.emit('destroyed', undefined as unknown as void);
  }
}
