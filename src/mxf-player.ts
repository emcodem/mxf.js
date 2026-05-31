import { EventEmitter, MxfPlayerEvents, ManifestData } from './events.js';
import { MseController } from './mse/mse-controller.js';
import { WebAudioController } from './audio/web-audio-controller.js';
import { ScrubController } from './scrub-controller.js';
import { WorkerCommand, WorkerEvent } from './worker/worker-messages.js';
import { CHUNK_DURATION_SECONDS } from './core/constants.js';

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
  private readonly audio: WebAudioController;
  private nextFetchFrame = 0;
  private framesPerChunk = 50;   // fetch ~2 seconds at 25fps
  private fetchPending = false;
  // Set when the SourceBuffer is full and nothing behind the playhead can be evicted (the forward
  // buffer alone is over quota — e.g. high-bitrate AVC-Intra). Blocks fetching until the playhead
  // advances and trimBackBuffer() frees room; cleared in onTimeUpdate.
  private bufferFull = false;
  private editRateNumerator = 25;
  private editRateDenominator = 1;
  private seqBase = 0;
  private pendingInitSegment: ArrayBuffer | null = null;
  // Seek coalescing: while scrubbing, many 'seeking' events fire. We post a worker seek for
  // each (so the decoder always tracks the latest position) but only fetch once all have been
  // acknowledged, so we don't transcode for stale intermediate positions.
  private pendingSeeks = 0;
  private seekTargetFrame = 0;
  // The fast-drag scrub state machine (single-flight preview pump + gated render cycle). See
  // ScrubController. While it isActive, normal forward fetching is suspended.
  private readonly scrub: ScrubController;
  // Mode the in-flight seek was issued with — read when its 'seeked' reply arrives, since the
  // scrub state may have changed (e.g. endScrub) between issuing and the reply.
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
    this.audio = new WebAudioController(this.video, (info) => this.emit('audio-info', info));
    this.scrub = new ScrubController(
      this.video,
      (targetFrame, seq) => this.worker?.postMessage({ type: 'scrubPreview', targetFrame, seq } as WorkerCommand),
      (timeSeconds) => this.initiateSeek(timeSeconds, 'accurate'),
    );

    this.video.addEventListener('seeking', () => this.onVideoSeeking());
    this.video.addEventListener('seeked', () => this.onVideoSeeked());
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

  /**
   * Which seeking strategy the loaded file supports, or null before the manifest arrives:
   * 'cbg' (constant-byte-count math), 'vbe' (per-frame index entries), or 'none' (growing/live —
   * approximate offset-percentage seeking). Useful for tailoring UI (e.g. exact vs approximate seek).
   */
  get indexMode(): 'cbg' | 'vbe' | 'none' | null {
    return this.manifest?.indexMode ?? null;
  }

  play(): void {
    // If parked on a fast preview, re-establish a clean accurate decode at the current position
    // before playing forward so playback starts from a proper frame with correct timestamps.
    if (this.previewParked && this.manifest) this.initiateSeek(this.video.currentTime, 'accurate');
    this.video.play().catch(() => {});
    // PCM audio plays via Web Audio; resume the context on user gesture.
    this.audio.resume();
  }

  pause(): void {
    this.video.pause();
    this.audio.suspend();
  }

  /** Seek to a time in seconds. The <video> 'seeking' event drives the worker fetch. */
  seek(timeSeconds: number): void {
    if (!this.manifest) return;
    const clamped = Math.max(0, Math.min(timeSeconds, this.manifest.duration));
    this.video.currentTime = clamped;
  }

  /**
   * Enter scrub mode. While scrubbing, feed the live drag position to `scrubTo()` (e.g. from a
   * slider's `input` event); each position triggers a fast GOP-head preview. Crucially, the drag
   * does NOT move the <video> playhead — that only happens once a preview is buffered, so the
   * picture keeps updating instead of stalling on positions whose frame hasn't arrived yet. The
   * video is paused for the duration (scrub renders by seeking the paused element onto each ready
   * preview frame); endScrub() resumes playback if it was running.
   */
  beginScrub(): void {
    // Free the worker for previews the instant scrubbing starts: drop any in-flight/queued forward
    // prefetch (the in-flight transcode bails on the generation bump). Without this, a scrub that
    // begins while a forward buffer-fill is running waits behind it before previews appear. The
    // abandoned fetch won't post segmentDone, so clear fetchPending — endScrub's seek re-arms it.
    this.worker?.postMessage({ type: 'cancelPrefetch' } as WorkerCommand);
    this.fetchPending = false;
    this.scrub.beginScrub();
  }

  /**
   * Report a live drag position (seconds) during scrubbing. Records it as the newest target and
   * kicks the single-flight preview pump; does NOT touch video.currentTime (see beginScrub()).
   */
  scrubTo(timeSeconds: number): void {
    this.scrub.scrubTo(timeSeconds);
  }

  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position):
   * decodes the preceding keyframe up to the exact target so the final picture is precise, then
   * resumes normal forward fetching (and playback, if it was running). Call on the slider's
   * `change` event. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(timeSeconds?: number): void {
    this.scrub.endScrub(timeSeconds);
  }

  /** Total number of PCM audio channels in the loaded file (0 until audio starts arriving). */
  get audioChannels(): number {
    return this.audio.channels;
  }

  /** Source channels (0-based) currently routed to the stereo output. */
  get activeChannels(): number[] {
    return this.audio.activeChannels;
  }

  /**
   * Choose which source audio channels are played. Indices are 0-based. The selected channels are
   * mixed down to the stereo output by selection-order parity (1st→L, 2nd→R, 3rd→L, …); a single
   * selected channel plays centre. Takes effect on subsequently scheduled audio (within the current
   * audio buffer-ahead). Passing an empty array mutes audio.
   */
  setAudioChannels(channels: number[]): void {
    this.audio.setActiveChannels(channels); // applies to already-buffered audio (near-instant)
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
    this.worker.addEventListener('error', (e: ErrorEvent) => {
      // A bare ErrorEvent with no message usually means the worker MODULE failed to load/evaluate
      // (e.g. the dev server restarted — Vite restarts on vite.config.ts changes — and an already
      // open tab's worker died; reload the page). Surface filename/line and the underlying error
      // so it's diagnosable instead of an opaque "Worker error".
      const detail = [e.message, e.filename && `${e.filename}:${e.lineno ?? '?'}:${e.colno ?? '?'}`,
        (e.error as Error | undefined)?.stack].filter(Boolean).join(' — ');
      console.error('[jsmxf] worker error:', e, e.error);
      this.emit('error', {
        message: detail || 'Worker failed to load — reload the page (the dev server may have restarted)',
        fatal: true,
      });
    });
    this.worker.addEventListener('messageerror', (e) => {
      this.emit('error', { message: `Worker message error: ${String(e)}`, fatal: true });
    });
    this.mseController = new MseController(this.video, !!this.config.debug);
    this.mseController.on('error', ({ track, message }) => {
      this.emit('error', { message: `MSE ${track}: ${message}`, fatal: false });
    });
    // Back-pressure: the forward buffer is over quota — stop fetching until the playhead advances.
    this.mseController.on('bufferfull', () => { this.bufferFull = true; this.fetchPending = false; });
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
        this.audio.schedule(event.samples, event.sampleRate, event.channelCount, event.editUnit);
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

      case 'previewDone':
        this.scrub.onPreviewDone(event.editUnit);
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
    this.audio.setEditRate(event.editRateNumerator, event.editRateDenominator);
    this.scrub.setStream(event.duration, event.editRateNumerator, event.editRateDenominator);

    const fps = event.editRateNumerator / event.editRateDenominator;
    this.framesPerChunk = Math.ceil(fps * CHUNK_DURATION_SECONDS);

    this.manifest = {
      duration: event.duration,
      editRateNumerator: event.editRateNumerator,
      editRateDenominator: event.editRateDenominator,
      tracks: event.tracks,
      pictureDescriptor: pd,
      soundDescriptor: sd,
      indexMode: event.indexMode,
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
        this.audio.createContext(sd.sampleRate);
      }
    }

    // Announce the audio channel count at load time (the worker decoded the first audio to get the
    // true count) so the UI can build a channel selector before playback starts. The controller
    // re-announces only if a decoded chunk's running count differs.
    this.audio.applyChannelCount(event.audioChannelCount);

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
    if (this.scrub.isActive) return;
    // Parked on a fast preview: don't auto-advance. A seek (play()/endScrub()/new seek) un-parks.
    if (this.previewParked) return;
    // SourceBuffer is full and can't be trimmed yet — wait for the playhead to advance.
    if (this.bufferFull) return;
    if (this.fetchPending || !this.manifest) return;

    const currentTime = this.video.currentTime;
    const fps = this.editRateNumerator / this.editRateDenominator;

    // Cap by REQUESTED-ahead, not buffered-ahead. nextFetchFrame is exactly how far ahead we've
    // already asked for, so this bounds prefetch to maxBufferSeconds regardless of how the decoded
    // timeline lands in `buffered` (a transcode timeline that lags, or fragmented ranges, made the
    // old buffered-ahead check undercount and prefetch the WHOLE file → worker saturation + quota).
    // Prefetch is cancelled wholesale when a scrub starts (beginScrub → cancelPrefetch), so it's
    // fine to fill the full look-ahead here regardless of play/pause state.
    const requestedAheadSeconds = this.nextFetchFrame / fps - currentTime;
    if (requestedAheadSeconds >= this.config.maxBufferSeconds) return;

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
    // Ignore 'seeking' events we caused ourselves (rendering a preview frame, or the endScrub
    // settle) — otherwise they'd be mistaken for a user drag/seek and re-trigger work.
    if (this.scrub.consumeSuppressedSeeking()) return;
    const targetTime = this.video.currentTime;
    this.emit('seeking', { targetTime });
    // During scrubbing the drag is reported via scrubTo() (which does not move the playhead), so a
    // genuine 'seeking' here is unusual — route it to the pump for safety rather than a full seek.
    if (this.scrub.isActive) {
      this.scrub.scrubTo(targetTime);
      return;
    }
    this.initiateSeek(targetTime, this.config.seekMode);
  }

  private onVideoSeeked(): void {
    // A seek completing is one signal a frame painted — let the scrub controller complete its cycle.
    this.scrub.onVideoSeeked();
  }

  private initiateSeek(targetTime: number, mode: 'keyframe' | 'accurate'): void {
    if (!this.manifest) return;
    this.fetchPending = true; // pause fetching until the last outstanding seek resolves
    this.activeSeekMode = mode;
    // A new seek supersedes any parked preview; this seek will define the next decode start.
    this.previewParked = false;
    // A seek targets a (likely unbuffered) new region, so prior buffer-full back-pressure no longer
    // applies — clear it so the post-seek fetch isn't blocked (otherwise a seek can stall forever).
    this.bufferFull = false;

    this.seekTargetFrame = Math.round(
      targetTime * this.editRateNumerator / this.editRateDenominator
    );
    this.pendingSeeks++;

    // Stop audio scheduled for the old position and drop the anchor so the next chunk re-locks to
    // the new playhead — otherwise audio keeps playing at the pre-seek offset.
    this.audio.flush();
    this.audio.resetAnchor();

    const cmd: WorkerCommand = { type: 'seek', targetFrame: this.seekTargetFrame };
    this.worker!.postMessage(cmd);
  }

  private onTimeUpdate(): void {
    if (!this.manifest) return;
    const currentTime = this.video.currentTime;
    // While scrubbing the playhead hops to far-apart preview positions; trimming relative to it
    // would evict the very preview/settle frames we need. Only manage the forward-playback buffer
    // when not scrubbing.
    if (!this.scrub.isActive) {
      // Evict already-played media so the resident buffer stays bounded, and release the buffer-full
      // back-pressure now the playhead has advanced (trimming may have freed room).
      this.mseController?.trimBackBuffer(currentTime);
      this.bufferFull = false;
    }
    const aheadSeconds = this.mseController?.getBufferedAhead('video', currentTime) ?? 0;

    if (aheadSeconds < this.config.startBufferSeconds) {
      if (this.previewParked && !this.video.paused && !this.scrub.isActive) {
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

  private log(msg: string): void {
    if (this.config.debug) console.log('[jsmxf]', msg);
  }

  private destroyInternal(): void {
    this.worker?.terminate();
    this.worker = null;
    this.mseController?.destroy();
    this.mseController = null;
    this.audio.destroy();
    this.manifest = null;
    this.nextFetchFrame = 0;
    this.fetchPending = false;
    this.bufferFull = false;
    this.seqBase = 0;
    this.pendingInitSegment = null;
    this.pendingSeeks = 0;
    this.seekTargetFrame = 0;
    this.activeSeekMode = 'accurate';
    this.previewParked = false;
    this.scrub.reset();
  }

  destroy(): void {
    this.destroyInternal();
    this.removeAllListeners();
    this.emit('destroyed', undefined as unknown as void);
  }
}
