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
  /**
   * Default seek behaviour for seek():
   * - 'accurate' (default): decode from the preceding keyframe up to the exact target frame, so
   *   the displayed picture is the requested frame.
   * - 'keyframe': decode only the GOP-head I-frame and show it for the whole GOP — near-instant,
   *   lands on a random-access point rather than the exact frame.
   * While scrubbing (between beginScrub() and endScrub()) keyframe mode is always used regardless
   * of this setting; endScrub() then settles on an accurate frame.
   */
  seekMode?: 'keyframe' | 'accurate';
  debug?: boolean;
}

const DEFAULT_CONFIG: Required<MxfConfig> = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: 'auto',
  seekMode: 'accurate',
  debug: false,
};

/**
 * MxfPlayer renders all video through the native <video> element via MSE.
 *
 * Sources that the browser cannot play natively (e.g. MPEG-2) are transcoded to H.264
 * fMP4 in the worker before they reach MSE; H.264 sources are remuxed to fMP4 directly.
 * Either way the <video> element is the single render + clock + seeking surface, so
 * timeline scrubbing works for every source. (An earlier WebCodecs→<canvas> render path
 * has been retired — it could not seek and duplicated the playback clock.)
 *
 * PCM audio, which MSE generally cannot play, is decoded to Float32 in the worker and
 * scheduled through the Web Audio API alongside the silent (video-only) <video>.
 */
export class MxfPlayer extends EventEmitter<MxfPlayerEvents> {
  private readonly video: HTMLVideoElement;
  private readonly config: Required<MxfConfig>;
  private worker: Worker | null = null;
  private mseController: MseController | null = null;
  private manifest: ManifestData | null = null;
  private audioCxt: AudioContext | null = null;
  private nextFetchFrame = 0;
  private framesPerChunk = 50;   // fetch ~2 seconds at 25fps
  private fetchPending = false;
  private editRateNumerator = 25;
  private editRateDenominator = 1;
  private seqBase = 0;
  private pendingInitSegment: ArrayBuffer | null = null;
  // Anchor mapping presentation time 0 → AudioContext time, for Web Audio PCM scheduling.
  private audioStartTime: number | null = null;
  // Seek coalescing: while scrubbing, many 'seeking' events fire. We post a worker seek for
  // each (so the decoder always tracks the latest position) but only fetch once all have been
  // acknowledged, so we don't transcode for stale intermediate positions.
  private pendingSeeks = 0;
  private seekTargetFrame = 0;
  // True between beginScrub()/endScrub(): every seek uses fast I-frame-only mode and normal
  // forward fetching is suspended so it can't compete with preview decodes.
  private scrubbing = false;
  // Mode the in-flight seek was issued with — read when its 'seeked' reply arrives, since the
  // scrubbing flag may have changed (e.g. endScrub) between issuing and the reply.
  private activeSeekMode: 'keyframe' | 'accurate' = 'accurate';
  // True after a fast keyframe preview: playback is "parked" on a stretched I-frame. The decoder
  // counter has advanced past the keyframe, so forward playback must NOT resume by fetching from
  // here (it would double-emit the I-frame with a shifted timestamp). Any new seek — including the
  // accurate settle from endScrub() or play() — clears this and re-establishes a clean decode.
  private previewParked = false;

  constructor(video: HTMLVideoElement, config: MxfConfig = {}) {
    super();
    this.video = video;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.video.addEventListener('seeking', () => this.onVideoSeeking());
    this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
  }

  get currentTime(): number {
    return this.video.currentTime;
  }

  get duration(): number {
    return this.manifest?.duration ?? 0;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  play(): void {
    // If parked on a fast preview, re-establish a clean accurate decode at the current position
    // before playing forward so playback starts from a proper frame with correct timestamps.
    if (this.previewParked && this.manifest) this.initiateSeek(this.video.currentTime, 'accurate');
    this.video.play().catch(() => {});
    // PCM audio plays via Web Audio; resume the context on user gesture.
    this.audioCxt?.resume().catch(() => {});
  }

  pause(): void {
    this.video.pause();
    this.audioCxt?.suspend().catch(() => {});
  }

  /** Seek to a time in seconds. The <video> 'seeking' event drives the worker fetch. */
  seek(timeSeconds: number): void {
    if (!this.manifest) return;
    const clamped = Math.max(0, Math.min(timeSeconds, this.manifest.duration));
    this.video.currentTime = clamped;
  }

  /**
   * Enter scrub mode: subsequent seeks (e.g. from dragging a timeline slider) decode only the
   * GOP-head I-frame and show it instantly, instead of decoding up to the exact target. Wire a
   * slider's live `input` events to seek() between beginScrub() and endScrub() for smooth, cheap
   * preview while dragging. The timeline thumb is never snapped — the preview frame covers its
   * whole GOP, so the picture is the keyframe at-or-before the dragged position.
   */
  beginScrub(): void {
    this.scrubbing = true;
  }

  /**
   * Leave scrub mode and settle on an accurate frame at the current position: decodes the
   * preceding keyframe up to the exact target so the final picture is precise, then resumes
   * normal forward fetching. Call this when the user releases the slider (its `change` event).
   */
  endScrub(): void {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (!this.manifest) return;
    // currentTime is already at the released position (no 'seeking' event will fire), so kick
    // off an accurate seek explicitly to refine the picture and re-establish a clean decode.
    this.initiateSeek(this.video.currentTime, 'accurate');
  }

  loadUrl(url: string): void {
    this.setup();
    const cmd: WorkerCommand = { type: 'initUrl', url, debug: this.config.debug, videoMode: 'mse' };
    this.worker!.postMessage(cmd);
  }

  loadFile(file: File): void {
    this.setup();
    const cmd: WorkerCommand = { type: 'initFile', file, debug: this.config.debug, videoMode: 'mse' };
    this.worker!.postMessage(cmd);
  }

  private setup(): void {
    this.destroyInternal();
    this.worker = this.createWorker();
    this.worker.addEventListener('message', (e: MessageEvent<WorkerEvent>) => this.onWorkerMessage(e.data));
    this.worker.addEventListener('error', (e) => {
      this.emit('error', { message: e.message ?? 'Worker error', fatal: true });
    });
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
        if (this.mseController?.hasVideoBuffer() || this.mseController?.hasAudioBuffer()) {
          // MSE is already open — append directly and start fetching.
          this.mseController.appendSegment('video', event.data);
          this.mseController.appendSegment('audio', event.data);
          this.fetchNextChunk();
        } else {
          // MSE not ready yet (sourceopen race) — store for onManifest to flush.
          this.pendingInitSegment = event.data;
        }
        break;

      case 'videoSegment':
        this.mseController?.appendSegment('video', event.data);
        break;

      case 'audioSegment':
        this.mseController?.appendSegment('audio', event.data);
        break;

      case 'pcmSamples':
        this.emit('pcm-audio', {
          samples: event.samples,
          sampleRate: event.sampleRate,
          channelCount: event.channelCount,
          editUnit: event.editUnit,
        });
        this.schedulePCMAudio(event.samples, event.sampleRate, event.channelCount, event.editUnit);
        break;

      case 'segmentDone':
        // The worker posts this after every fetch, regardless of which of video / audio /
        // PCM were present. Using it as the single "fetch complete" signal is robust to
        // segments that carry video but no audio frames (interleaving), which otherwise
        // left fetchPending stuck and stalled playback after the first segment.
        this.fetchPending = false;
        this.fetchNextChunk();
        break;

      case 'seeked': {
        this.pendingSeeks = Math.max(0, this.pendingSeeks - 1);
        // Only the last outstanding seek matters — the worker decoder is now positioned for it.
        if (this.pendingSeeks > 0) break;
        const keyframe = event.nearestKeyframeEditUnit;
        this.nextFetchFrame = keyframe;
        this.fetchPending = false;

        if (this.activeSeekMode === 'keyframe') {
          // Fast preview: decode just the GOP-head I-frame and stretch it across its GOP so the
          // <video> shows it for any currentTime up to the next keyframe. Cover at least up to
          // the dragged target in case the index's GOP length is short. No normal fetch resumes
          // here — endScrub() (or a non-scrub seek) settles and restarts forward playback.
          const stretch = Math.max(event.gopFrameCount, this.seekTargetFrame - keyframe + 1, 1);
          this.fetchKeyframePreview(keyframe, stretch);
          break;
        }

        // Accurate: decode keyframe→target (plus a couple frames) so the seeked picture appears
        // quickly instead of transcoding a full 2 s chunk; forward playback then resumes with
        // normal-size chunks from nextFetchFrame.
        const seekChunk = Math.min(
          this.framesPerChunk,
          Math.max(1, this.seekTargetFrame - keyframe + 3),
        );
        this.fetchNextChunk(seekChunk);
        break;
      }

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

    // Use the resolved output codec for the MIME type (e.g. 'h264' for transcoded MPEG-2).
    const effectiveVideoCodec = event.resolvedVideoCodec ?? pd?.codec ?? 'unknown';
    const videoMime = (pd && event.videoCodecSupported)
      ? MseController.getMimeType('video', effectiveVideoCodec)
      : null;
    let audioMime = sd ? MseController.getMimeType('audio', sd.codec) : null;

    if (sd?.codec === 'pcm') {
      if (this.config.pcmAudioMode === 'webaudio' || !audioMime) {
        // PCM that MSE can't play is decoded in the worker and scheduled via Web Audio.
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

  /**
   * Fetch a single I-frame at `keyframe` for a fast scrub preview, telling the worker to stretch
   * that one decoded sample across `stretchFrames` frame periods so it covers its whole GOP on the
   * MSE timeline. Posted directly (not via fetchNextChunk) so it isn't gated by the scrub guard.
   */
  private fetchKeyframePreview(keyframe: number, stretchFrames: number): void {
    if (!this.manifest) return;
    this.previewParked = true;      // forward playback must re-seek accurately before resuming
    this.nextFetchFrame = keyframe; // park here; endScrub() resumes forward playback from the keyframe
    const cmd: WorkerCommand = {
      type: 'fetchSegment',
      startFrame: keyframe,
      frameCount: 1,
      seqBase: this.seqBase,
      stretchToFrames: stretchFrames,
    };
    this.seqBase += 2;
    this.worker!.postMessage(cmd);
  }

  private fetchNextChunk(frameCount = this.framesPerChunk): void {
    // Suspend normal forward fetching while scrubbing — previews drive the buffer instead, and a
    // normal fetch from nextFetchFrame would compete with them on the shared decoder/encoder.
    if (this.scrubbing) return;
    // Parked on a fast preview: don't auto-advance. A seek (play()/endScrub()/new seek) un-parks.
    if (this.previewParked) return;
    if (this.fetchPending || !this.manifest) return;

    // Range-aware: how much is buffered *from the current position*, not the end of some
    // unrelated later range. Returns 0 when currentTime sits in an unbuffered gap, so a seek
    // there always fetches instead of mistaking a far-ahead range for "buffered enough".
    const currentTime = this.video.currentTime;
    const aheadSeconds = this.mseController?.getBufferedAhead('video', currentTime) ?? 0;

    if (aheadSeconds >= this.config.maxBufferSeconds) return;

    const totalFrames = Math.round(
      this.manifest.duration * this.editRateNumerator / this.editRateDenominator
    );
    if (this.nextFetchFrame >= totalFrames) {
      this.mseController?.endOfStream();
      return;
    }

    this.fetchPending = true;
    const cmd: WorkerCommand = {
      type: 'fetchSegment',
      startFrame: this.nextFetchFrame,
      frameCount,
      seqBase: this.seqBase,
    };
    this.seqBase += 2;
    this.nextFetchFrame += frameCount;
    this.worker!.postMessage(cmd);
  }

  private onVideoSeeking(): void {
    if (!this.manifest) return;
    const targetTime = this.video.currentTime;
    this.emit('seeking', { targetTime });
    // While scrubbing every seek is a fast I-frame-only preview; otherwise honour the config.
    this.initiateSeek(targetTime, this.scrubbing ? 'keyframe' : this.config.seekMode);
  }

  private initiateSeek(targetTime: number, mode: 'keyframe' | 'accurate'): void {
    if (!this.manifest) return;
    this.fetchPending = true; // pause fetching until the last outstanding seek resolves
    this.activeSeekMode = mode;
    // A new seek supersedes any parked preview; this seek will define the next decode start.
    this.previewParked = false;

    this.seekTargetFrame = Math.round(
      targetTime * this.editRateNumerator / this.editRateDenominator
    );
    this.pendingSeeks++;

    const cmd: WorkerCommand = { type: 'seek', targetFrame: this.seekTargetFrame };
    this.worker!.postMessage(cmd);
  }

  private onTimeUpdate(): void {
    if (!this.manifest) return;
    const currentTime = this.video.currentTime;
    const aheadSeconds = this.mseController?.getBufferedAhead('video', currentTime) ?? 0;

    if (aheadSeconds < this.config.startBufferSeconds) {
      if (this.previewParked && !this.video.paused && !this.scrubbing) {
        // Playing forward off a parked preview (e.g. global keyframe mode): re-seek accurately at
        // the current position to get a clean decode, then normal fetching resumes from there.
        this.initiateSeek(currentTime, 'accurate');
      } else {
        this.fetchNextChunk();
      }
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
    this.worker?.terminate();
    this.worker = null;
    this.mseController?.destroy();
    this.mseController = null;
    this.audioCxt?.close().catch(() => {});
    this.audioCxt = null;
    this.audioStartTime = null;
    this.manifest = null;
    this.nextFetchFrame = 0;
    this.fetchPending = false;
    this.seqBase = 0;
    this.pendingInitSegment = null;
    this.pendingSeeks = 0;
    this.seekTargetFrame = 0;
    this.scrubbing = false;
    this.activeSeekMode = 'accurate';
    this.previewParked = false;
  }

  destroy(): void {
    this.destroyInternal();
    this.removeAllListeners();
    this.emit('destroyed', undefined as unknown as void);
  }
}
