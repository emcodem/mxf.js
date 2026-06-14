import { EventEmitter, MxfPlayerEvents, ManifestData, TimecodeBundle, TimecodeSource } from './events.js';
import { MseController } from './mse/mse-controller.js';
import { WebAudioController } from './audio/web-audio-controller.js';
import { ScrubController } from './scrub-controller.js';
import { WorkerCommand, WorkerEvent, WorkerPluginConfig, ManifestTimecode, TimecodeAnchor } from './worker/worker-messages.js';
import { frameCountToTimecode, formatTimecode } from './parser/timecode.js';
import { CHUNK_DURATION_SECONDS, FIRST_CHUNK_DURATION_SECONDS, MIN_CHUNK_FRAMES, RESUME_BUFFER_SECONDS } from './core/constants.js';

/**
 * Configuration for a wasm-backed video decoder plugin. The module must be an
 * emscripten-compiled ffmpeg decoder built with the dec_create / dec_send_packet /
 * dec_receive_frame / dec_frame_width / dec_frame_height / dec_get_rgba / dec_free API.
 */
export interface VideoDecoderPluginConfig {
  /**
   * URL to the emscripten-generated .js factory file (the .wasm is loaded automatically
   * from the same directory). E.g. '/dist/mpeg2-decoder.js'.
   */
  moduleUrl: string;
  /**
   * FFmpeg codec name passed to dec_create(), e.g. 'mpeg2video', 'prores', 'mjpeg'.
   * Common codecs are mapped automatically to their MXF descriptor IDs; use mxfCodec
   * to override when the automatic mapping is wrong or missing.
   */
  ffmpegCodec: string;
  /**
   * The pd.codec value that activates this plugin. Defaults to a built-in map
   * ('mpeg2video' → 'mpeg2', 'h264' → 'h264') or falls back to ffmpegCodec.
   * Only set this when the automatic mapping is wrong.
   */
  mxfCodec?: string;
}

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
  /**
   * Seconds of media that must be buffered ahead before (re)starting playback after a cold start, a
   * seek, or a stall. The first decoded picture is shown immediately (with `buffering: true`) while
   * this fills, then playback begins. Smaller = snappier resume but more likely to re-buffer on a
   * thin/decode-bound source; larger = slower resume but smoother once playing. Default 0.75.
   */
  resumeBufferSeconds?: number;
  debug?: boolean;
  /**
   * Open files via loadLive() as growing live recordings: the index is ignored, playback starts near
   * the file's end and follows it forward, there is no seeking/scrubbing, and the player emits
   * 'live-end' when a file completes so the consumer can switch to the next one. Default false.
   */
  live?: boolean;
  /**
   * Live catch-up strategy — how to close the gap when the playhead falls behind the live edge (a
   * stall, a backgrounded tab, decode falling behind). Playback runs at 1× by default, so lag never
   * shrinks on its own.
   * - 'speed' (default): nudge playback to `catchupRate` (audio pitches up slightly) to drain
   *   accumulated lag, restoring 1× at the edge; falls back to a hard jump for lag ≥ catchupJumpSeconds.
   * - 'jump': no speed change — hard re-anchor to the live edge (via a 'catchup-jump' event the
   *   consumer wires to reanchorLive) once lag ≥ catchupJumpSeconds.
   * - 'off': never catch up.
   */
  liveCatchupStrategy?: 'speed' | 'jump' | 'off';
  /** Playback rate used by the 'speed' strategy while catching up (default 1.1). Kept gentle: the
   *  Web Audio path follows this rate, so it pitches up audibly — 1.05–1.15 is a sensible range. */
  catchupRate?: number;
  /** Engage the 'speed' catch-up when at least this many seconds behind the edge (default 5). Set
   *  above the steady-state latency so normal play never triggers it — only a real stall / backgrounded
   *  tab does. */
  catchupStartSeconds?: number;
  /** Disengage the 'speed' catch-up once within this many seconds of the edge (default 2). This is a
   *  TARGET LATENCY, not zero: stopping here leaves a safety buffer so playback never presses the
   *  bleeding edge (which, with a thin live buffer, causes single-frame edge-starvation rebuffers).
   *  Catch-up restores this safe latency after a stall rather than chasing zero. */
  catchupStopSeconds?: number;
  /** Lag (seconds behind the edge) at/above which to hard-jump to the edge instead of speeding —
   *  the 'jump' strategy's only trigger, and the 'speed' strategy's far-behind fallback (default 15).
   *  Must exceed maxBufferSeconds to be reachable, since lag beyond it is reported by the consumer. */
  catchupJumpSeconds?: number;
  /** Optional decoder plugin. When the MXF codec matches, this wasm decoder is used instead
   *  of the built-in JS decoder, enabling new codecs and Firefox-compatible paths. */
  plugins?: {
    videoDecoder?: VideoDecoderPluginConfig;
  };
}

/** Built-in FFmpeg-codec-name → pd.codec mapping for common cases. */
const FFMPEG_TO_MXF_CODEC: Record<string, string> = {
  'mpeg2video': 'mpeg2',
  'h264':       'h264',
  'libx264':    'h264',
};

function resolveWorkerPlugin(p: VideoDecoderPluginConfig): WorkerPluginConfig {
  const mxfCodec = p.mxfCodec ?? FFMPEG_TO_MXF_CODEC[p.ffmpegCodec] ?? p.ffmpegCodec;
  return { moduleUrl: p.moduleUrl, ffmpegCodec: p.ffmpegCodec, mxfCodec };
}

const DEFAULT_CONFIG: Required<MxfConfig> = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: 'auto',
  seekMode: 'accurate',
  resumeBufferSeconds: RESUME_BUFFER_SECONDS,
  debug: false,
  live: false,
  liveCatchupStrategy: 'speed',
  catchupRate: 1.1,
  catchupStartSeconds: 5,
  catchupStopSeconds: 2,
  catchupJumpSeconds: 15,
  plugins: {},
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
  // Cold-start ramp: the first forward fetches start small (fast first paint on a thin line) and
  // grow ×2 up to framesPerChunk. Seeded in onManifest; consumed only by default fetchNextChunk().
  private rampChunkFrames = 50;
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
  // True between play() and pause() — the user wants playback. Distinct from video.paused: while
  // buffering at startup / after a seek / after a stall, we keep the element paused (showing the
  // first decoded picture) even though playIntent is true, then start it once enough is buffered.
  private playIntent = false;
  // Current buffering state (playback held/stalled for data). Surfaced via the `buffering` event and
  // the `buffering` getter; only emitted on change (see setBuffering).
  private isBuffering = false;
  // One-shot buffer gate, armed on cold start / play() / seek and cleared once playback actually
  // starts ('playing'). While armed, the element is held paused until RESUME_BUFFER_SECONDS is
  // buffered (kills the cold-start stutter + the silent post-seek freeze). Once playback is running
  // we do NOT re-pause on every micro-underrun — that oscillates against itself; mid-playback stalls
  // are surfaced as the buffering indicator only and the element recovers natively.
  private startupGating = false;

  // ── Live mode (growing recording, follow-the-edge + seamless file switch) ─────
  // True between loadLive() and the file completing. In live mode there is no seeking/scrubbing and
  // no EOF cap on fetching; the worker streams forward and reports the live edge via 'liveUpdate'.
  private liveMode = false;
  // True when the worker's live reader has caught up to the file's current end (no new frames). While
  // set, forward fetching pauses and we poll the source size until it grows.
  private liveAtEdge = false;
  // Consecutive at-edge polls with no growth — used (with a ready standby) to declare the file done.
  private liveStallPolls = 0;
  private readonly LIVE_POLL_MS = 1000;
  private readonly LIVE_STALL_MAX = 3;
  private livePollTimer: ReturnType<typeof setTimeout> | null = null;
  // Standby worker pre-bootstrapping the NEXT file so the switch is (near-)seamless. Captures its
  // manifest + init segment during preload; activated when the current file completes.
  private standbyWorker: Worker | null = null;
  private standbyReady = false;
  private standbyManifest: Extract<WorkerEvent, { type: 'manifest' }> | null = null;
  // The standby worker's preload message listener (manifest/initSegment capture), kept so it can be
  // removed before the full listener set is attached at activation (avoids double message handling).
  private standbyListener: ((e: MessageEvent<WorkerEvent>) => void) | null = null;
  // Captured standby init segment, so a clean re-anchor (reanchorLive) can re-append it to a fresh
  // MSE without re-parsing the header (it's identical across same-encoder chunks).
  private standbyInitSegment: ArrayBuffer | null = null;
  // reanchorLive() target + a flag to swap as soon as the standby finishes pre-parsing.
  private reanchorPending = false;
  // True between beginGaplessSwitch() (flushLiveTail posted to the old worker) and activateStandby()
  // running on the liveTailFlushed reply. Guards against re-entrancy and stray liveUpdates mid-switch.
  private switching = false;
  // The next file's URL captured by switchLive/preloadNextUrl, surfaced in the 'live-switched' event.
  private pendingNextUrl: string | null = null;
  // Guards a single 'live-end' emission per completed file (re-armed on switch / new load).
  private liveEndEmitted = false;

  // ── Live catch-up (close the gap to the live edge) ────────────────────────────
  // True while the 'speed' strategy has playback nudged above 1× to drain lag.
  private catchupActive = false;
  // Latches one 'catchup-jump' emission while lag stays above the jump threshold; re-armed once lag
  // drops back under it (e.g. after the consumer re-anchors to the edge) so it can fire again later.
  private catchupJumpPending = false;
  // Lag estimate (seconds behind the live edge) reported by the consumer (it owns the playlist, so it
  // is the authority on large, file-scale lag — the jump trigger). 0 until reported. The fine-grained
  // small-lag signal for the speed strategy is bufferedAhead() (≈ min(maxBuffer, true lag): when we're
  // behind, the worker fills the buffer toward the cap; at the edge it drains to ~0).
  private reportedLagSeconds = 0;

  // ── Timecode ────────────────────────────────────────────────────────────────
  // Computed package start timecodes (material/file/source), from the manifest. Per-frame System
  // Item timecode arrives as sparse anchors (presentation editUnit → absolute frame count), kept
  // sorted by editUnit; a rendered frame's system TC is the nearest preceding anchor + offset. Both
  // are reset per file in onManifest.
  private manifestTimecodes: ManifestTimecode[] = [];
  private systemAnchors: TimecodeAnchor[] = [];
  // The last edit unit a `timecode` event was emitted for (dedupe — both rVFC and timeupdate feed it).
  private lastTimecodeEditUnit = -1;
  private currentTimecodeBundle: TimecodeBundle | null = null;
  // requestVideoFrameCallback handle (0 = not scheduled / unsupported → timeupdate drives it).
  private rvfcHandle = 0;
  private destroyed = false;

  constructor(video: HTMLVideoElement, config: MxfConfig = {}) {
    super();
    this.video = video;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.audio = new WebAudioController(this.video, (info) => this.emit('audio-info', info), !!this.config.debug);
    this.scrub = new ScrubController(
      this.video,
      (targetFrame, seq) => this.worker?.postMessage({ type: 'scrubPreview', targetFrame, seq } as WorkerCommand),
      (timeSeconds) => this.initiateSeek(timeSeconds, 'accurate'),
      () => this.play(),
    );

    this.video.addEventListener('seeking', () => this.onVideoSeeking());
    this.video.addEventListener('seeked', () => this.onVideoSeeked());
    this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
    // Buffering / stall handling. 'waiting' = the element ran out of buffered data mid-playback; we
    // pause it and re-buffer to RESUME_BUFFER_SECONDS before resuming, turning a native stutter
    // (resume-on-one-frame) into one clean gated resume. 'playing' = playback (re)started.
    this.video.addEventListener('waiting', () => this.onVideoWaiting());
    this.video.addEventListener('playing', () => { this.startupGating = false; this.setBuffering(false); });
    this.video.addEventListener('canplay', () => this.maybeResumePlayback());
    // Treat any element-initiated play (e.g. <video autoplay>, or a consumer calling video.play()
    // directly) as play intent so the buffer gate + buffering indicator apply to it too. NOTE: we do
    // NOT clear playIntent on 'pause' — the gate pauses the element itself while buffering, and that
    // must not be read as the user pausing; only the pause() method clears intent.
    // Resume the PCM AudioContext here too: this fires within the user gesture for element-initiated
    // play (native controls / a direct video.play()), so audio unlocks even when play() isn't used.
    this.video.addEventListener('play', () => {
      this.playIntent = true;
      this.audio.resume();
      // Native/autoplay start (<video autoplay>, native controls, or a consumer calling video.play())
      // begins playback at the browser's HAVE_FUTURE_DATA point — a thin ~0.2 s buffer — which would
      // otherwise BYPASS the one-shot startup gate (maybeResumePlayback only acts on a paused element).
      // On a decode-bound source (MPEG-2 transcode runs only ~1.2× realtime) the playhead then
      // immediately catches the buffer frontier and stutters through several `waiting` events before
      // production pulls ahead. If the gate is still armed and we're not yet buffered to the resume
      // target, re-pause and route through it so playback starts ONCE from a healthy buffer.
      // maybeResumePlayback clears startupGating before it calls video.play(), so our own intended
      // start never bounces back through here.
      if (this.startupGating && !this.video.paused && this.bufferedAhead() < this.resumeTargetSeconds()) {
        this.video.pause();
        this.maybeResumePlayback();
      }
    });

    // Per-rendered-frame timecode: requestVideoFrameCallback's mediaTime is the EXACT composited
    // frame's time, so the timecode never lags the picture. Self-reschedules; timeupdate is the
    // fallback (and covers paused/seek-settle and browsers without rVFC). Dedup by edit unit.
    this.startVideoFrameCallback();
  }

  private startVideoFrameCallback(): void {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    if (typeof v.requestVideoFrameCallback !== 'function') return; // timeupdate drives it instead
    const cb = (_now: number, meta: { mediaTime: number }): void => {
      if (this.destroyed) return;
      this.updateTimecode(meta.mediaTime);
      this.rvfcHandle = v.requestVideoFrameCallback!(cb);
    };
    this.rvfcHandle = v.requestVideoFrameCallback(cb);
  }

  /**
   * Resolve the timecode bundle for the frame at `timeSeconds` and emit `timecode` on change. Fed by
   * both rVFC (mediaTime, exact) and timeupdate (currentTime, fallback); deduped by edit unit so the
   * two never double-emit.
   *
   * The edit unit is `floor(time × fps)`, NOT round: a <video> presents the frame whose presentation
   * interval [N/fps, (N+1)/fps) contains the current time, i.e. frame `floor(time × fps)`. When the
   * playhead lands mid-frame (a seek to an arbitrary currentTime, e.g. 4.900 s at 25 fps = frame
   * 122.5), `round` would jump to 123 while the element still shows 122 — so the timecode read a
   * frame ahead of the picture. `floor` ties the timecode to the frame actually on screen; the small
   * epsilon absorbs float error so an exactly-aligned rVFC mediaTime (N/fps) doesn't fall to N−1.
   */
  private updateTimecode(timeSeconds: number): void {
    if (!this.manifest) return;
    const fps = this.editRateNumerator / this.editRateDenominator;
    if (!(fps > 0)) return;
    const editUnit = Math.max(0, Math.floor(timeSeconds * fps + 1e-6));
    if (editUnit === this.lastTimecodeEditUnit) return;
    this.lastTimecodeEditUnit = editUnit;
    const bundle = this.computeTimecodeBundle(editUnit);
    this.currentTimecodeBundle = bundle;
    this.emit('timecode', bundle);
  }

  /** System Item timecode at a presentation edit unit: nearest preceding anchor + linear offset. */
  private systemTimecodeAt(editUnit: number): string | null {
    let best: TimecodeAnchor | null = null;
    for (const a of this.systemAnchors) {
      if (a.editUnit <= editUnit && (!best || a.editUnit > best.editUnit)) best = a;
    }
    if (!best) return null;
    const fc = best.frameCount + (editUnit - best.editUnit);
    return formatTimecode(frameCountToTimecode(fc, best.base, best.dropFrame));
  }

  /** Build the full timecode bundle (system + computed package TCs) for a rendered edit unit. */
  private computeTimecodeBundle(editUnit: number): TimecodeBundle {
    const all: TimecodeBundle['all'] = [];

    const sys = this.systemTimecodeAt(editUnit);
    if (sys !== null) all.push({ source: 'system', text: sys, reliable: true });

    // Computed package TCs are exact only when the absolute edit unit is exact (indexed modes).
    const computedReliable = this.manifest?.indexMode !== 'none';
    const fps = this.editRateNumerator / this.editRateDenominator;
    for (const tc of this.manifestTimecodes) {
      const tcRate = tc.editRateDenominator > 0 ? tc.editRateNumerator / tc.editRateDenominator : fps;
      // Map the video edit unit onto the timecode track's own rate (usually 1:1).
      const offset = fps > 0 ? Math.round(editUnit * (tcRate / fps)) : editUnit;
      const text = formatTimecode(frameCountToTimecode(tc.position + offset, tc.base, tc.dropFrame));
      all.push({ source: tc.source, text, reliable: computedReliable });
    }

    // Priority order for display: system → material → source → file.
    const rank: Record<TimecodeSource, number> = { system: 0, material: 1, source: 2, file: 3 };
    all.sort((a, b) => rank[a.source] - rank[b.source]);
    const primary = all.length ? { source: all[0].source, text: all[0].text } : null;
    return { editUnit, primary, all };
  }

  /** The most recently computed timecode bundle for the frame on screen (null before playback). */
  get currentTimecode(): TimecodeBundle | null {
    return this.currentTimecodeBundle;
  }

  /** Merge fresh System Item anchors, keeping the list sorted/deduped by edit unit and bounded. */
  private mergeSystemAnchors(anchors: TimecodeAnchor[]): void {
    for (const a of anchors) {
      const i = this.systemAnchors.findIndex(x => x.editUnit === a.editUnit);
      if (i >= 0) this.systemAnchors[i] = a; else this.systemAnchors.push(a);
    }
    this.systemAnchors.sort((x, y) => x.editUnit - y.editUnit);
    // Anchors are sparse (≈1 per segment for continuous TC), but bound growth over long sessions.
    const MAX = 4096;
    if (this.systemAnchors.length > MAX) this.systemAnchors.splice(0, this.systemAnchors.length - MAX);
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
   * True when playback is held/stalled waiting for more data (the first picture may be visible but
   * the playhead isn't advancing). Mirrors the `buffering` event; poll this or listen to the event
   * to drive a "Buffering…" indicator.
   */
  get buffering(): boolean {
    return this.isBuffering;
  }

  /**
   * Which seeking strategy the loaded file supports, or null before the manifest arrives:
   * 'cbg' (constant-byte-count math), 'vbe' (per-frame index entries), or 'none' (growing/live —
   * approximate offset-percentage seeking). Useful for tailoring UI (e.g. exact vs approximate seek).
   */
  get indexMode(): 'cbg' | 'vbe' | 'none' | null {
    return this.manifest?.indexMode ?? null;
  }

  /** Active picture dimensions of the loaded video (the real frame, not the per-field StoredHeight),
   *  or null before the manifest arrives. Pair with {@link aspectRatio} for the displayed shape. */
  get videoDimensions(): { width: number; height: number } | null {
    if (!this.manifest) return null;
    return { width: this.manifest.displayWidth, height: this.manifest.displayHeight };
  }

  /** Display aspect ratio (DAR) of the loaded video, e.g. `{num:16,den:9}`, or null for square
   *  pixels / before the manifest. The picture is already rendered at this shape. */
  get aspectRatio(): { num: number; den: number } | null {
    return this.manifest?.aspectRatio ?? null;
  }

  play(): void {
    // If parked on a fast preview, re-establish a clean accurate decode at the current position
    // before playing forward so playback starts from a proper frame with correct timestamps.
    if (this.previewParked && this.manifest) this.initiateSeek(this.video.currentTime, 'accurate');
    this.playIntent = true;
    this.startupGating = true;   // gate this start on the buffer (cleared once 'playing' fires)
    // PCM audio plays via Web Audio, slaved to the <video> clock: resume the context on this user
    // gesture. The scheduler follows the element's own state (it gates on !paused), so audio won't
    // sound during the buffer gate that holds the element paused, and starts when the picture does.
    this.audio.resume();
    // Don't blindly video.play() into an empty/thin buffer (the source of the cold-start stutter and
    // the "frozen for 2 s after a seek" feeling). maybeResumePlayback() shows the first decoded frame
    // and a buffering indicator, fills to RESUME_BUFFER_SECONDS, then starts playback.
    this.maybeResumePlayback();
  }

  pause(): void {
    this.playIntent = false;
    this.video.pause();
    this.audio.onSeek();   // stop audio at once — the playhead is frozen
    // Deliberately NOT suspending the AudioContext: the scheduler already goes silent while the element
    // is paused (tick gates on !paused, and onSeek stopped the live sources). suspend()/resume() are
    // async and race on rapid pause/play, which left the context briefly suspended → audio dropouts.
    // Keeping it running (idle-silent) makes resume instant and glitch-free.
    this.setBuffering(false);
  }

  /** Seek to a time in seconds. The <video> 'seeking' event drives the worker fetch. No-op in live
   *  mode (the timeline is open-ended and playback only streams forward). */
  seek(timeSeconds: number): void {
    if (!this.manifest || this.liveMode) return;
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
    // Stop forward audio at once so the pre-scrub sound can't keep playing while the picture jumps
    // around on previews; the scheduler re-locks on endScrub's accurate settle.
    this.audio.onSeek();
    this.scrub.beginScrub();
  }

  /**
   * Report a live drag position (seconds) during scrubbing. Records it as the newest target and
   * kicks the single-flight preview pump; does NOT touch video.currentTime (see beginScrub()).
   */
  scrubTo(timeSeconds: number): void {
    // Indexless (Tier-3 'none') files have no keyframe map to resolve a fast preview against, so
    // live scrub previews are disabled — endScrub() still settles accurately at the released
    // position (a normal, possibly slow, seek). Skip arming the single-flight preview pump.
    if (this.indexMode === 'none') return;
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

  /**
   * Set the master audio volume: 0 = silent, 1 = unity (default); values above 1 boost and may clip.
   * Applies to the Web Audio PCM path (the only audible path — the <video> element is muted). Safe to
   * call before playback starts; the level is retained and applied once the audio context exists.
   */
  setVolume(volume: number): void {
    this.audio.setVolume(volume);
  }

  /**
   * Diagnostics: dump the recent audio-scheduling history to the console — call the instant a glitch
   * is heard. Only does anything when the player was created with `debug: true` (which enables audio
   * diagnostics). See WebAudioController.dumpDiag for the dump format.
   */
  markAudioGlitch(label = ''): void {
    this.audio.dumpDiag(label);
  }

  /** DIAG (remove after debug): live audio↔picture snapshot for an external sampler — the perceived
   *  A/V offset (avOffset), audio coverage ahead, and cumulative anomaly counts. See
   *  WebAudioController.diagSnapshot. */
  audioDiag(): ReturnType<WebAudioController['diagSnapshot']> {
    return this.audio.diagSnapshot();
  }

  loadUrl(url: string): void {
    this.setup();
    const plugins = this.config.plugins?.videoDecoder
      ? { videoDecoder: resolveWorkerPlugin(this.config.plugins.videoDecoder) } : undefined;
    const cmd: WorkerCommand = { type: 'initUrl', url, debug: this.config.debug, videoMode: 'mse', plugins };
    this.worker!.postMessage(cmd);
  }

  /**
   * Open a still-growing recording as a live stream: start near the file's current end, follow it
   * forward, and emit 'live-end' when it completes (call {@link switchLive}/{@link preloadNextUrl} to
   * continue with the next file). No seeking/scrubbing while live. The index is ignored (frames are
   * streamed straight forward), so this works for any codec/index. `startEditUnit` is 0 for the first
   * file; rotated files inherit a continuous counter automatically on switch.
   */
  loadLive(url: string): void {
    this.setup();
    const plugins = this.config.plugins?.videoDecoder
      ? { videoDecoder: resolveWorkerPlugin(this.config.plugins.videoDecoder) } : undefined;
    // First live file: jump to its edge (liveFromStart=false), number frames from 0.
    const cmd: WorkerCommand = { type: 'initUrl', url, debug: this.config.debug, videoMode: 'mse', plugins, live: true, startEditUnit: 0, liveFromStart: false };
    this.worker!.postMessage(cmd);
  }

  loadFile(file: File): void {
    this.setup();
    const plugins = this.config.plugins?.videoDecoder
      ? { videoDecoder: resolveWorkerPlugin(this.config.plugins.videoDecoder) } : undefined;
    const cmd: WorkerCommand = { type: 'initFile', file, debug: this.config.debug, videoMode: 'mse', plugins };
    this.worker!.postMessage(cmd);
  }

  /** Create + wire a fresh MseController. Shared by setup() and the clean live re-anchor
   *  (reanchorToStandby), so both behave identically. */
  private createMseController(): void {
    this.mseController = new MseController(this.video, !!this.config.debug);
    this.mseController.on('error', ({ track, message }) => {
      this.emit('error', { message: `MSE ${track}: ${message}`, fatal: false });
    });
    // Back-pressure: the forward buffer is over quota — stop fetching until the playhead advances.
    this.mseController.on('bufferfull', () => { this.bufferFull = true; this.fetchPending = false; });
    // A video append finished (buffered ranges updated): if we're holding playback for the buffer
    // gate (cold start / post-seek / post-stall), re-evaluate whether there's now enough to resume.
    this.mseController.on('appended', ({ track }) => {
      if (track === 'video' && this.playIntent && this.video.paused) this.maybeResumePlayback();
    });
  }

  private setup(): void {
    this.destroyInternal();
    this.worker = this.createWorker();
    this.attachWorkerListeners(this.worker);
    this.createMseController();
  }

  private createWorker(): Worker {
    const workerUrl = new URL('./demux-worker.js', import.meta.url);
    return new Worker(workerUrl, { type: 'module' });
  }

  /** Wire the message / error / messageerror handlers onto a worker. Shared by setup() and the
   *  standby→active worker swap (activateStandby), so the new live worker behaves identically. */
  private attachWorkerListeners(worker: Worker): void {
    worker.addEventListener('message', (e: MessageEvent<WorkerEvent>) => this.onWorkerMessage(e.data));
    worker.addEventListener('error', (e: ErrorEvent) => {
      // A bare ErrorEvent with no message usually means the worker MODULE failed to load/evaluate
      // (e.g. the dev server restarted — Vite restarts on vite.config.ts changes — and an already
      // open tab's worker died; reload the page). Surface filename/line and the underlying error
      // so it's diagnosable instead of an opaque "Worker error".
      const detail = [e.message, e.filename && `${e.filename}:${e.lineno ?? '?'}:${e.colno ?? '?'}`,
        (e.error as Error | undefined)?.stack].filter(Boolean).join(' — ');
      console.error('[mxf.js] worker error:', e, e.error);
      this.emit('error', {
        message: detail || 'Worker failed to load — reload the page (the dev server may have restarted)',
        fatal: true,
      });
    });
    worker.addEventListener('messageerror', (e) => {
      this.emit('error', { message: `Worker message error: ${String(e)}`, fatal: true });
    });
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
        if (event.systemTcAnchors?.length) this.mergeSystemAnchors(event.systemTcAnchors);
        // Long-GOP fetches are GOP-aligned and may cover more frames than requested; adopt the
        // worker's reported next start so forward fetches stay keyframe-aligned and tile exactly.
        if (event.nextFrame !== undefined && !this.scrub.isActive && !this.previewParked) {
          this.nextFetchFrame = event.nextFrame;
        }
        // A segment just landed: if we're holding playback for buffer (cold start / post-seek /
        // post-stall), re-evaluate whether there's now enough to start. The append is asynchronous,
        // so re-check on the MSE 'updateend' too — but this covers the common case immediately.
        if (this.playIntent && this.video.paused) this.maybeResumePlayback();
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

      case 'liveUpdate':
        this.onLiveUpdate(event);
        break;

      case 'liveTailFlushed':
        // The old worker has drained its held reorder frames (the flushed tail videoSegment landed
        // just before this) and reports the seam base = the EARLIER of its two track frontiers, so
        // neither track gaps (the lagging one abuts, the leading one overlaps a few units — replaced,
        // not gapped). Adopt it as the next file's continuous base and complete the swap.
        if (this.switching) {
          this.nextFetchFrame = event.nextEditUnit;
          this.activateStandby();
        }
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

    // Live mode: there's no meaningful total duration (the file is still growing), so the timeline is
    // open-ended — use Infinity for MSE/duration (the standard live convention). The forward frontier
    // (nextFetchFrame) and the playhead operate in the worker's continuous edit-unit space.
    this.liveMode = event.live ?? false;
    this.liveAtEdge = false;
    this.liveStallPolls = 0;
    const effectiveDuration = this.liveMode ? Infinity : event.duration;

    this.editRateNumerator = event.editRateNumerator;
    this.editRateDenominator = event.editRateDenominator;
    this.audio.setEditRate(event.editRateNumerator, event.editRateDenominator);
    this.scrub.setStream(event.duration, event.editRateNumerator, event.editRateDenominator);

    const fps = event.editRateNumerator / event.editRateDenominator;
    this.framesPerChunk = Math.ceil(fps * CHUNK_DURATION_SECONDS);
    // Reset the cold-start ramp for this file: first fetch ≈ FIRST_CHUNK_DURATION_SECONDS of frames.
    this.rampChunkFrames = Math.max(MIN_CHUNK_FRAMES, Math.ceil(fps * FIRST_CHUNK_DURATION_SECONDS));
    // Arm the one-shot buffer gate for the very first playback, so an autoplaying <video> is held to
    // RESUME_BUFFER_SECONDS (showing "buffering") instead of stuttering through the thin cold buffer.
    this.startupGating = true;

    // Reset timecode state for the new file.
    this.manifestTimecodes = event.timecodes ?? [];
    this.systemAnchors = [];
    this.lastTimecodeEditUnit = -1;
    this.currentTimecodeBundle = null;

    this.manifest = {
      duration: effectiveDuration,
      editRateNumerator: event.editRateNumerator,
      editRateDenominator: event.editRateDenominator,
      tracks: event.tracks,
      pictureDescriptor: pd,
      soundDescriptor: sd,
      displayWidth: event.displayWidth,
      displayHeight: event.displayHeight,
      aspectRatio: event.aspectRatio,
      indexMode: event.indexMode,
      longGop: event.longGop,
      timecodes: event.timecodes ?? [],
      live: this.liveMode,
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

    this.mseController!.setDuration(effectiveDuration);

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

  private fetchNextChunk(explicitFrames?: number): void {
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

    // Live mode: no EOF cap — stream forward. If the worker is caught up to the live edge, don't spin;
    // poll the source size and resume when it grows. nextFetchFrame is NOT advanced here — the worker
    // reports the authoritative forward frontier (the continuous edit unit) back via 'liveUpdate'.
    if (this.liveMode) {
      if (this.liveAtEdge) { this.scheduleLivePoll(); return; }
      const frameCount = explicitFrames ?? this.nextRampChunk();
      this.fetchPending = true;
      this.worker!.postMessage({ type: 'fetchSegment', startFrame: this.nextFetchFrame, frameCount, seqBase: this.seqBase } as WorkerCommand);
      this.seqBase += 2;
      return;
    }

    const totalFrames = Math.round(
      this.manifest.duration * this.editRateNumerator / this.editRateDenominator
    );
    if (this.nextFetchFrame >= totalFrames) {
      this.mseController?.endOfStream();
      return;
    }

    // Resolve the chunk size only now that we're committed to posting — an explicit size (the seek
    // path) bypasses the ramp; a default forward fetch consumes and grows it. Computing it here (not
    // as a default arg) means the early-return guards above don't burn ramp steps.
    const frameCount = explicitFrames ?? this.nextRampChunk();

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

  /** Return the current cold-start ramp size, then grow it ×2 toward framesPerChunk. A fresh load
   *  ramps ~0.25 s → 0.5 s → 1 s → 2 s so the first paint is fast without a big first download, then
   *  settles at the full chunk. Reset per file in onManifest. */
  private nextRampChunk(): number {
    const n = this.rampChunkFrames;
    this.rampChunkFrames = Math.min(this.framesPerChunk, this.rampChunkFrames * 2);
    return n;
  }

  private onVideoSeeking(): void {
    if (!this.manifest) return;
    // Live mode has no seeking — the timeline is open-ended and the worker streams strictly forward.
    // Ignore any 'seeking' (e.g. a user dragging native controls) so it can't desync the live reader.
    if (this.liveMode) return;
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
    // Cheap in-buffer seek (frame-step, rewind, click within the already-buffered region): the
    // requested frame is already in BOTH the video MSE buffer and the resident PCM store, so the
    // element paints it immediately and audio can re-tile from chunks already decoded. A full worker
    // seek here would re-transcode keyframe→target, reset the forward-fetch frontier backward and
    // abort the in-flight prefetch — and, for audio, refetch chunks we already hold, which insertChunk
    // then evicts and replaces with not-yet-transcoded ones (the post-seek dropout). So skip all
    // worker work; the frontier (nextFetchFrame) is preserved and forward fetching continues from the
    // same range. Works whether paused or playing: when playing we drop the audio anchor so the
    // scheduler re-locks to the new playhead from the RESIDENT store (no refetch — ~one tick of
    // silence instead of a multi-second underrun). A paused element re-locks on the next play().
    if (!this.previewParked && this.isSeekServedByBuffer(targetTime)) {
      this.audio.onSeek();
      return;
    }
    this.initiateSeek(targetTime, this.config.seekMode);
  }

  /**
   * True when `targetTime` is already buffered contiguously up to (or past) the forward-fetch
   * frontier, so a seek there needs no worker work: the element paints the frame from the existing
   * buffer, and when playback later drains to the end of that range, forward fetching resumes exactly
   * there (nextFetchFrame) with no gap. If the containing range ends before the frontier (a gap
   * between here and where we'd resume fetching), this returns false and a real seek is required.
   */
  private isSeekServedByBuffer(targetTime: number): boolean {
    if (!this.mseController || !this.manifest) return false;
    const videoAhead = this.mseController.getBufferedAhead('video', targetTime);
    if (videoAhead <= 0) return false;                // target isn't inside any buffered video range
    // The Web Audio PCM path must ALSO have the target resident, else skipping the worker seek strands
    // audio with no decoded chunk at the new playhead. bufferedAhead returns Infinity for non-Web-Audio
    // files (MSE audio / no audio), so this never blocks them; 0 means the target PCM is uncovered.
    const audioAhead = this.audio.bufferedAhead(targetTime);
    if (audioAhead <= 0) return false;
    const fps = this.editRateNumerator / this.editRateDenominator;
    // Both buffers must tile contiguously up to where forward fetch will resume (capped at the stream
    // end for a fully-fetched file). Required of BOTH tracks — NOT a blanket "served" when video is all
    // fetched: a backward seek can land where video is fully resident but audio was evicted/diverged;
    // skipping the re-seek there would strand the audio gate forever (no forward fetch left to fill it).
    const frontierTime = Math.min(this.nextFetchFrame / fps, this.manifest.duration) - 0.5;
    return targetTime + videoAhead >= frontierTime && targetTime + audioAhead >= frontierTime;
  }

  private onVideoSeeked(): void {
    // A seek completing is one signal a frame painted — let the scrub controller complete its cycle.
    this.scrub.onVideoSeeked();
  }

  private initiateSeek(targetTime: number, mode: 'keyframe' | 'accurate'): void {
    if (!this.manifest) return;
    this.fetchPending = true; // pause fetching until the last outstanding seek resolves
    // Re-arm the one-shot buffer gate: the target region is (likely) unbuffered, so the resume after
    // this seek should hold for the buffer + show "buffering" rather than stall silently.
    this.startupGating = true;
    // Hold the element NOW if it's playing — don't wait for a native 'waiting' event, which only fires
    // when VIDEO is missing. A forward seek can land where video is still buffered (a prior pass) but
    // audio has diverged/been evicted: the element keeps PLAYING with no audio (no 'waiting', no gate),
    // and this seek's refetch resets the fetch frontier back to the keyframe, starving video too —
    // "audio drops + video hangs, no buffering". Pausing routes the resume through maybeResumePlayback,
    // which holds (buffering) until the post-seek fetch refills BOTH tracks in sync, then plays once.
    // The paused element still paints the seeked frame from the buffer, so the picture jumps instantly.
    if (!this.video.paused) { this.video.pause(); this.setBuffering(true); }
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

    // Stop audio scheduled for the old position and drop the anchor so the scheduler re-locks to the
    // new playhead — otherwise audio keeps playing at the pre-seek offset.
    this.audio.onSeek();

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
      // Drop orphan ranges left far ahead by abandoned seeks (heavy ±10s skipping / scrub previews)
      // — well beyond where forward fetch fills, so never the active region.
      this.mseController?.trimForwardOrphans(currentTime, this.config.maxBufferSeconds + 5);
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

    this.emit('timeupdate', { currentTime, duration: this.duration });
    // Fallback timecode update (rVFC drives it per-frame where available; this covers paused/seek
    // settle and browsers without rVFC). Deduped by edit unit so it never double-emits with rVFC.
    this.updateTimecode(currentTime);
    if (this.liveMode) this.evaluateCatchup(); // drain/disengage catch-up as the buffer changes
  }

  /** Buffered-ahead seconds of video at the current playhead (0 if unknown). */
  private bufferedAhead(): number {
    return this.mseController?.getBufferedAhead('video', this.video.currentTime) ?? 0;
  }

  /** Seconds of forward buffer required before (re)starting playback: RESUME_BUFFER_SECONDS, capped at
   *  what remains to the end so the final fraction of a clip can still start. Shared by the startup
   *  gate (maybeResumePlayback) and the autoplay/native-start interception in the 'play' handler. */
  private resumeTargetSeconds(): number {
    const remaining = Math.max(0, this.duration - this.video.currentTime);
    return Math.min(this.config.resumeBufferSeconds, Math.max(0, remaining - 0.05));
  }

  /** Update + emit the buffering state, but only when it actually changes. */
  private setBuffering(buffering: boolean): void {
    if (this.isBuffering === buffering) return;
    this.isBuffering = buffering;
    this.emit('buffering', { buffering, bufferedSeconds: this.bufferedAhead() });
  }

  /**
   * Single decision point for starting/holding playback. Called from play(), after each appended
   * video segment, on 'canplay', and from the stall handler. If the user wants to play and the
   * element is paused: start it once at least RESUME_BUFFER_SECONDS is buffered ahead (or we've
   * fetched to EOF / are within that of the end); otherwise hold, show "buffering", and keep
   * fetching. The first decoded picture is already painted by the paused element, so the viewer sees
   * the frame immediately while the buffer fills — no cold-start stutter, no silent post-seek freeze.
   */
  private maybeResumePlayback(): void {
    if (!this.playIntent || !this.manifest) return;
    if (this.scrub.isActive) return;          // the scrub controller owns the element while scrubbing
    // A seek is in flight: its refetch is about to REPLACE the chunks around the target (insertChunk
    // stops the live audio source and the slow re-transcode leaves a gap), and the fetch frontier still
    // reflects the OLD position (a stale-EOF bypass). Resuming now plays onto a buffer that's about to
    // be clobbered — the post-seek dropout, even when the resident buffer looks full (v/a ≥ target from
    // a prior playthrough). So hold and show buffering until 'seeked' lands and the post-seek fetch
    // refills BOTH buffers in sync; we then resume ONCE from a healthy buffer and the clobber happened
    // silently while paused. Released as soon as 'seeked' decrements pendingSeeks — a live worker always
    // replies 1:1, so this can't wedge; only a dead worker leaves it pending (which can't play anyway,
    // and surfaces via the worker 'error' path).
    if (this.pendingSeeks > 0) { this.setBuffering(true); return; }
    if (!this.video.paused) { this.setBuffering(false); return; }

    const fps = this.editRateNumerator / this.editRateDenominator;
    const totalFrames = Math.round(this.manifest.duration * fps);
    const fetchedToEof = this.nextFetchFrame >= totalFrames;
    const target = this.resumeTargetSeconds();

    // Gate on BOTH video and the Web Audio PCM path. The audio (decoded to Web Audio, not MSE) is
    // decoupled from the video buffer, so resuming on video alone after a seek would start the picture
    // while the audio store is still empty/short — the playhead then outruns the late-arriving chunks
    // and they drop 'behind-unplayed' (a second-plus of silence). audioAhead is Infinity for non-Web-
    // Audio files, so this is a no-op there. fetchedToEof still forces a start (can't fetch more).
    const audioAhead = this.audio.bufferedAhead(this.video.currentTime);
    const videoAhead = this.bufferedAhead();
    // Deadlock breaker: forward fetch is bounded by requested-ahead, so once video is buffered a full
    // maxBuffer past the playhead, NO further fetch runs — a short/diverged audio buffer will never be
    // backfilled. Waiting for audio in that state hangs on "buffering" forever (video full, audio
    // short). When the fetch is capped (or we're at EOF), don't gate on audio — resume on video; audio
    // catches up as the playhead advances and re-opens the fetch window.
    const requestedAhead = this.nextFetchFrame / fps - this.video.currentTime;
    const audioStuck = fetchedToEof || requestedAhead >= this.config.maxBufferSeconds;
    const willPlay = (videoAhead >= target && (audioAhead >= target || audioStuck)) || fetchedToEof;
    if (this.config.debug) {
      this.log(`gate cur=${this.video.currentTime.toFixed(2)} v=${videoAhead.toFixed(2)} ` +
        `a=${audioAhead === Infinity ? 'inf' : audioAhead.toFixed(2)} target=${target.toFixed(2)} ` +
        `eof=${fetchedToEof} pending=${this.pendingSeeks} reqAhead=${requestedAhead.toFixed(2)} ` +
        `stuck=${audioStuck} → ${willPlay ? 'PLAY' : 'hold'} vbuf=${this.videoRanges()} abuf=${this.audio.debugStore()}`);
    }
    if (willPlay) {
      // Disarm the one-shot gate on the play ATTEMPT, not on the 'playing' event: if the element
      // can't immediately sustain (a decode-bound source stalls right after the buffered range),
      // 'playing' may never fire, and a still-armed gate would force-pause→replay in a tight loop.
      // After this single attempt, mid-playback stalls are surfaced via the indicator only.
      this.startupGating = false;
      this.setBuffering(false);
      this.video.play().catch(() => {});
    } else {
      this.setBuffering(true);
      this.fetchNextChunk();
    }
  }

  /**
   * The element ran out of buffered data mid-playback ('waiting'). Rather than let it resume the
   * instant a single frame arrives (which produces the stutter), pause it and re-buffer through
   * maybeResumePlayback() so it resumes once cleanly. Ignored while scrubbing / parked on a preview
   * (those manage the element themselves) or when the user has paused.
   */
  private onVideoWaiting(): void {
    if (!this.playIntent || this.scrub.isActive || this.previewParked) return;
    if (this.config.debug) this.log(`waiting cur=${this.video.currentTime.toFixed(2)} gating=${this.startupGating} pending=${this.pendingSeeks} vbuf=${this.videoRanges()}`);
    this.setBuffering(true);
    // Only the one-shot startup gate forcibly holds the element (cold start / post-seek): re-buffer
    // to RESUME_BUFFER_SECONDS, then resume once. A mid-playback underrun (gate already cleared) just
    // shows the indicator and lets the element recover on its own — forcibly pausing on every
    // micro-underrun oscillates play/pause and makes the stutter worse.
    if (this.startupGating) {
      this.video.pause();
      this.maybeResumePlayback();
    }
  }

  // ── Live mode ────────────────────────────────────────────────────────────────

  /**
   * Worker forward-frontier / edge report (replaces segmentDone for live). Adopts the authoritative
   * forward frontier (continuous edit unit), tracks the edge/stall state, switches to the next file
   * when the current one completes, and keeps the forward buffer topped up.
   */
  private onLiveUpdate(event: Extract<WorkerEvent, { type: 'liveUpdate' }>): void {
    if (!this.liveMode) return;
    // Mid-switch: the old worker is being drained (flushLiveTail) and torn down; ignore its trailing
    // liveUpdates so they can't re-trigger a switch or advance the frontier past the aligned base.
    if (this.switching) { this.fetchPending = false; return; }
    this.fetchPending = false;
    this.nextFetchFrame = event.nextEditUnit; // authoritative frontier — never over/under-counts
    this.liveAtEdge = event.atEdge;

    if (event.atEdge) {
      this.liveStallPolls = event.grew ? 0 : this.liveStallPolls + 1;
      if (this.maybeCompleteLive()) return; // switched to next file — that path resumes fetching
      this.scheduleLivePoll();
    } else {
      this.liveStallPolls = 0;
    }

    if (this.playIntent && this.video.paused) this.maybeResumePlayback();
    this.fetchNextChunk(); // no-op when at edge or buffer full
    this.evaluateCatchup();
  }

  /** Schedule one source-size poll (single timer). */
  private scheduleLivePoll(): void {
    if (this.livePollTimer !== null || !this.liveMode) return;
    this.livePollTimer = setTimeout(() => {
      this.livePollTimer = null;
      this.worker?.postMessage({ type: 'pollLive' } as WorkerCommand);
    }, this.LIVE_POLL_MS);
  }

  /**
   * The current file has stopped growing (stalled at the edge). If the next file is already
   * bootstrapped, hand off to it seamlessly; otherwise emit 'live-end' once so the consumer can load
   * it (a brief gap until the standby is ready — see the v2 gapless mitigation in the plan).
   * Returns true if it activated the standby (the caller should stop further work this tick).
   */
  private maybeCompleteLive(): boolean {
    // A ready standby means the page already saw the NEXT contiguous file in the recorder's listing —
    // positive proof THIS file rotated (closed). So once the reader has reached its edge even once
    // (stallPolls >= 1, i.e. one no-growth poll confirming real EOF, not a transient mid-file catch-up)
    // hand off immediately, instead of burning LIVE_STALL_MAX (~3 s) of buffer headroom waiting — that
    // drain is exactly what left the playhead at the buffer end and caused the seam micro-rebuffer.
    if (this.standbyReady && this.liveStallPolls >= 1) { this.beginGaplessSwitch(); return true; }
    if (this.liveStallPolls < this.LIVE_STALL_MAX) return false;
    if (!this.liveEndEmitted) { this.liveEndEmitted = true; this.emit('live-end', undefined as unknown as void); }
    return false;
  }

  /**
   * Live mode: report how far (seconds) the playhead is behind the true live edge. The consumer owns
   * the playlist (e.g. /api/live-files), so it is the only authority on lag once it exceeds the local
   * buffer cap — `bufferedAhead()` saturates at maxBufferSeconds. Used together with bufferedAhead to
   * drive catch-up (see evaluateCatchup). No-op outside live mode.
   */
  setLiveLag(seconds: number): void {
    if (!this.liveMode) return;
    this.reportedLagSeconds = Math.max(0, seconds || 0);
    this.evaluateCatchup();
  }

  /**
   * Decide whether to catch up to the live edge, per liveCatchupStrategy. Called on the live cadence
   * (each liveUpdate/poll and each timeupdate). Lag = max(consumer-reported, local bufferedAhead):
   * the report covers large lag the local buffer can't see, bufferedAhead gives fine resolution for
   * the small-lag (speed) regime. Idempotent — state flags make the warnings fire only on transitions.
   */
  private evaluateCatchup(): void {
    const strategy = this.config.liveCatchupStrategy;
    if (!this.liveMode || strategy === 'off') {
      if (this.catchupActive) this.setCatchupSpeed(false, 0);
      return;
    }
    // A switch / jump is mid-flight: leave it to settle (its reset re-arms us) rather than stacking
    // another action on top.
    if (this.switching || this.reanchorPending) return;

    const buffered = this.bufferedAhead();
    const lag = Math.max(this.reportedLagSeconds, buffered);
    if (lag < this.config.catchupJumpSeconds) this.catchupJumpPending = false; // re-arm under the threshold

    // Hard jump (far behind): the 'jump' strategy's sole action, and 'speed''s far-behind fallback.
    // The player can't name files, so request the edge re-anchor via an event the consumer wires to
    // reanchorLive(newestUrl). Latched so it fires once per excursion above the threshold.
    if (lag >= this.config.catchupJumpSeconds) {
      if (this.catchupActive) this.setCatchupSpeed(false, lag); // drop any speed-up before the hard cut
      if (!this.catchupJumpPending) {
        this.catchupJumpPending = true;
        // eslint-disable-next-line no-console
        console.warn(`[live-catchup] jump → live edge (${lag.toFixed(1)}s behind)`);
        this.emit('catchup-jump', { lagSeconds: lag });
      }
      return;
    }

    if (strategy !== 'speed') return; // 'jump' strategy does nothing below the jump threshold

    if (!this.catchupActive) {
      if (lag >= this.config.catchupStartSeconds) this.setCatchupSpeed(true, lag);
    } else if (lag <= this.config.catchupStopSeconds) {
      this.setCatchupSpeed(false, lag); // drained back to the edge
    }
  }

  /** Engage/disengage the 'speed' catch-up: set the video element's rate AND tell the audio scheduler
   *  to follow it (so audio stays audible, pitched up, instead of muting as it does for J/L scrub). */
  private setCatchupSpeed(active: boolean, lag: number): void {
    if (this.catchupActive === active) return;
    this.catchupActive = active;
    const rate = active ? this.config.catchupRate : 1;
    this.audio.setCatchupRate(rate);
    this.video.playbackRate = rate;
    if (active) {
      // eslint-disable-next-line no-console
      console.warn(`[live-catchup] speed-up ×${rate} (${lag.toFixed(1)}s behind)`);
    } else {
      this.log('live-catchup: caught up — restored 1× speed');
    }
    this.emit('catchup', { active, rate, lagSeconds: lag });
  }

  /**
   * Bootstrap the NEXT file in a standby worker so the switch is (near-)seamless. The standby opens
   * the file live-from-start (its beginning is contiguous with the current file's end) and continues
   * the continuous edit-unit counter; the exact base is locked at activation. Captures the standby's
   * manifest + init segment but does NOT append the init to MSE (same codec → the existing
   * SourceBuffer continues). Idempotent while a standby is already pending.
   */
  preloadNextUrl(url: string): void {
    if (!this.liveMode || this.standbyWorker) return;
    this.standbyReady = false;
    this.standbyManifest = null;
    this.pendingNextUrl = url;
    const w = this.createWorker();
    this.standbyWorker = w;
    this.standbyListener = (e: MessageEvent<WorkerEvent>) => {
      const ev = e.data;
      if (ev.type === 'manifest') {
        this.standbyManifest = ev;
      } else if (ev.type === 'initSegment') {
        this.standbyReady = true;
        // Standby finished bootstrapping. If the current file already reached its edge (rotated), hand
        // off now rather than waiting for the next poll — same first-edge rule as maybeCompleteLive.
        if (this.liveAtEdge && this.liveStallPolls >= 1) this.beginGaplessSwitch();
      } else if (ev.type === 'error' && ev.fatal) {
        this.emit('error', { message: `standby preload: ${ev.message}`, fatal: false });
      }
    };
    w.addEventListener('message', this.standbyListener);
    const plugins = this.config.plugins?.videoDecoder
      ? { videoDecoder: resolveWorkerPlugin(this.config.plugins.videoDecoder) } : undefined;
    w.postMessage({
      type: 'initUrl', url, debug: this.config.debug, videoMode: 'mse', plugins,
      live: true, startEditUnit: this.nextFetchFrame, liveFromStart: true,
    } as WorkerCommand);
  }

  /**
   * Switch to the next live file. If it isn't already being preloaded, start preloading it now; the
   * actual hand-off happens as soon as the standby is ready and the current file is done. Call this
   * from the 'live-end' handler, or proactively when the next file appears in your playlist.
   */
  switchLive(url: string): void {
    if (!this.liveMode) { this.loadLive(url); return; }
    if (!this.standbyWorker) this.preloadNextUrl(url);
    if (this.standbyReady) this.beginGaplessSwitch();
  }

  /**
   * Begin the gapless hand-off to a ready standby. Before swapping, drain the OLD worker's held
   * reorder frames (flushLiveTail) so its video OUTPUT frontier catches up to its AUDIO frontier as far
   * as the file allows. The flushed tail video lands in MSE, then liveTailFlushed reports the seam base
   * = the earlier of the two track frontiers (so a mid-GOP cut where audio leads video can't leave a
   * video gap) and runs activateStandby(). Idempotent while a switch is in flight.
   */
  private beginGaplessSwitch(): void {
    if (this.switching) return;
    if (!this.standbyWorker || !this.standbyReady || !this.standbyManifest) return;
    this.switching = true;
    // Stop polling the old file; we're done with it.
    if (this.livePollTimer !== null) { clearTimeout(this.livePollTimer); this.livePollTimer = null; }
    this.seqBase += 2;
    this.worker?.postMessage({ type: 'flushLiveTail', seqBase: this.seqBase } as WorkerCommand);
  }

  /**
   * Swap the standby worker in as the active one, continuing the timeline on the SAME MSE buffer +
   * audio context with no gap (no teardown → no black/refill). Called from the liveTailFlushed reply,
   * so `nextFetchFrame` is the seam base (the earlier of the old file's two track frontiers); the next
   * file's first frame of each track continues from there — the lagging track abuts, the leading one
   * overlaps a few units (replaced, not gapped).
   */
  private activateStandby(): void {
    const sw = this.standbyWorker;
    const sm = this.standbyManifest;
    if (!sw || !this.standbyReady || !sm) { this.switching = false; return; }

    if (this.livePollTimer !== null) { clearTimeout(this.livePollTimer); this.livePollTimer = null; }
    // Lock the next file's continuous base to the seam frontier (min of audio/video frontiers).
    sw.postMessage({ type: 'setStartEditUnit', startEditUnit: this.nextFetchFrame } as WorkerCommand);

    // Swap: terminate the old worker, promote the standby. Replace its preload listener with the full
    // set. Its already-received init segment is NOT appended (same codec → existing buffer continues).
    this.worker?.terminate();
    if (this.standbyListener) { sw.removeEventListener('message', this.standbyListener); this.standbyListener = null; }
    this.worker = sw;
    this.standbyWorker = null;
    this.standbyReady = false;
    this.standbyManifest = null;
    this.attachWorkerListeners(sw);

    // Adopt the next file's edit rate (same rate assumed; refresh defensively) and reset edge state.
    this.editRateNumerator = sm.editRateNumerator;
    this.editRateDenominator = sm.editRateDenominator;
    this.audio.setEditRate(sm.editRateNumerator, sm.editRateDenominator);
    this.liveAtEdge = false;
    this.liveStallPolls = 0;
    this.liveEndEmitted = false;
    this.fetchPending = false;
    this.previewParked = false;
    this.bufferFull = false;
    this.switching = false;

    const switchedUrl = this.pendingNextUrl;
    this.pendingNextUrl = null;
    this.log(`live: gapless switch to next file at editUnit ${this.nextFetchFrame}`);
    if (switchedUrl) this.emit('live-switched', { url: switchedUrl });
    this.fetchNextChunk();
    this.scheduleLivePoll();
  }

  /**
   * Edge re-anchor: jump to the live edge of `url` (a newer chunk just produced by the recorder) with
   * a CLEAN reset (fresh MSE + audio), reusing a pre-parsed standby worker so there is NO header
   * re-parse. Combines the standby pre-bootstrap (instant) with a clean cut (no A/V seam) — the basis
   * for low-latency edge-seeking live playback. Falls back to loadLive() when not in live mode.
   */
  reanchorLive(url: string): void {
    if (!this.liveMode) { this.loadLive(url); return; }
    if (this.standbyReady && this.standbyWorker) { this.reanchorToStandby(); return; }
    this.reanchorPending = true;
    if (!this.standbyWorker) this.preloadEdge(url);
  }

  /** Pre-parse `url` in a background standby worker (header + transcoder + init segment built while
   *  the current file keeps playing), so the swap in reanchorToStandby() is near-instant.
   *  liveFromStart:false → EDGE-SCAN (findLiveStartByte) to start near the file's current END, snapped
   *  to a clean keyframe. This is the catch-up-to-edge path: it must land at the live edge regardless of
   *  how old the target file is (it can be a freshly-rotated 1-2 s chunk OR the mid-write newest file
   *  ~a whole rotation old when we've fallen far behind). Starting at the file's BEGINNING here (the old
   *  behaviour) left us a whole file-duration behind → an immediate re-jump loop. Same as loadLive's
   *  first-file behaviour. startEditUnit:0 → fresh timeline. */
  private preloadEdge(url: string): void {
    if (this.standbyWorker) return;
    this.standbyReady = false; this.standbyManifest = null; this.standbyInitSegment = null;
    const w = this.createWorker();
    this.standbyWorker = w;
    this.standbyListener = (e: MessageEvent<WorkerEvent>) => {
      const ev = e.data;
      if (ev.type === 'manifest') {
        this.standbyManifest = ev;
      } else if (ev.type === 'initSegment') {
        this.standbyInitSegment = ev.data;
        this.standbyReady = true;
        if (this.reanchorPending) this.reanchorToStandby();
      } else if (ev.type === 'error' && ev.fatal) {
        this.emit('error', { message: `edge preload: ${ev.message}`, fatal: false });
      }
    };
    w.addEventListener('message', this.standbyListener);
    const plugins = this.config.plugins?.videoDecoder
      ? { videoDecoder: resolveWorkerPlugin(this.config.plugins.videoDecoder) } : undefined;
    w.postMessage({ type: 'initUrl', url, debug: this.config.debug, videoMode: 'mse', plugins,
      live: true, startEditUnit: 0, liveFromStart: false } as WorkerCommand);
  }

  /** Promote the pre-parsed standby worker with a clean MSE + audio reset (no gapless continuation,
   *  so no A/V seam). Reuses the standby's already-built transcoder + init segment — no header
   *  re-parse. Re-driving onManifest with the pre-parsed manifest re-opens MSE, recreates the audio
   *  context, flushes the (reused) init segment, and kicks the first edge fetch. */
  private reanchorToStandby(): void {
    const sw = this.standbyWorker; const sm = this.standbyManifest; const init = this.standbyInitSegment;
    if (!sw || !this.standbyReady || !sm || !init) return;
    this.reanchorPending = false;
    if (this.livePollTimer !== null) { clearTimeout(this.livePollTimer); this.livePollTimer = null; }

    // Promote the standby (do NOT terminate it); tear down only the outgoing worker.
    this.worker?.terminate();
    if (this.standbyListener) { sw.removeEventListener('message', this.standbyListener); this.standbyListener = null; }
    this.worker = sw;
    this.standbyWorker = null; this.standbyReady = false; this.standbyManifest = null; this.standbyInitSegment = null;
    this.attachWorkerListeners(sw);

    // Clean cut: fresh MSE + audio (mirrors loadLive's destroyInternal→onManifest reset, minus the
    // worker teardown so the pre-parsed transcoder survives).
    this.mseController?.destroy();
    this.createMseController();
    this.audio.destroy();
    this.nextFetchFrame = 0; this.seqBase = 0;
    this.fetchPending = false; this.bufferFull = false; this.previewParked = false;
    this.liveAtEdge = false; this.liveStallPolls = 0; this.liveEndEmitted = false;
    // Catch-up is satisfied by landing at the edge: clear speed/jump state (audio.destroy() above
    // already reset the scheduler's rate; restore the element's too).
    this.catchupActive = false; this.catchupJumpPending = false; this.reportedLagSeconds = 0;
    this.video.playbackRate = 1;
    this.playIntent = true;
    this.pendingInitSegment = init;
    this.log('live: re-anchored to edge (reused header, clean reset)');
    void this.onManifest(sm);
  }

  private log(msg: string): void {
    if (this.config.debug) console.log('[mxf.js]', msg);
  }

  /** Debug: the <video> element's buffered ranges as "[s1-e1][s2-e2]…" (a gap between ranges is the
   *  hang-then-skip symptom). */
  private videoRanges(): string {
    const b = this.video.buffered;
    let s = '';
    for (let i = 0; i < b.length; i++) s += `[${b.start(i).toFixed(2)}-${b.end(i).toFixed(2)}]`;
    return s || '[]';
  }

  private destroyInternal(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.standbyListener && this.standbyWorker) this.standbyWorker.removeEventListener('message', this.standbyListener);
    this.standbyWorker?.terminate();
    this.standbyWorker = null;
    this.standbyListener = null;
    this.standbyReady = false;
    this.standbyManifest = null;
    this.switching = false;
    this.pendingNextUrl = null;
    if (this.livePollTimer !== null) { clearTimeout(this.livePollTimer); this.livePollTimer = null; }
    this.liveMode = false;
    this.liveAtEdge = false;
    this.liveStallPolls = 0;
    this.liveEndEmitted = false;
    this.catchupActive = false;
    this.catchupJumpPending = false;
    this.reportedLagSeconds = 0;
    this.video.playbackRate = 1;
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
    this.playIntent = false;
    this.isBuffering = false;
    this.startupGating = false;
    this.manifestTimecodes = [];
    this.systemAnchors = [];
    this.lastTimecodeEditUnit = -1;
    this.currentTimecodeBundle = null;
    this.scrub.reset();
  }

  destroy(): void {
    this.destroyed = true;
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    if (this.rvfcHandle && typeof v.cancelVideoFrameCallback === 'function') {
      v.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = 0;
    this.destroyInternal();
    this.removeAllListeners();
    this.emit('destroyed', undefined as unknown as void);
  }
}
