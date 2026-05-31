/**
 * Fast-drag scrub state machine, extracted from MxfPlayer.
 *
 * Scrubbing renders by seeking the PAUSED <video> onto each ready preview frame — the drag itself
 * never moves the playhead (a position whose frame isn't buffered yet would stall the element). One
 * "cycle" = request a GOP-head preview for the latest dragged position → wait for the worker to
 * append it (previewDone) → move the playhead onto it → wait for the frame to actually paint
 * ('seeked') → start the next cycle at the freshest position. The cycle is gated end-to-end: the
 * playhead is NOT moved again until the previous seek COMPLETES, because re-setting currentTime
 * mid-seek aborts it and the frame never renders (the root cause of "stops playing frames"). So the
 * update rate self-paces to decode+render throughput; very fast drags skip intermediate positions
 * instead of freezing. A watchdog frees a wedged cycle if 'seeked' never arrives.
 *
 * The <video> remains the single render/clock/seeking surface; this controller only pauses it,
 * reads/sets currentTime, and reports the released position back for an accurate settle.
 */

/** One scrub cycle's phase. Replaces the former scrubCycleActive / scrubRenderPending booleans. */
const enum Cycle {
  /** No cycle running; ready to start one for the latest dragged position. */
  Idle,
  /** Preview requested from the worker; awaiting previewDone. */
  Decoding,
  /** Playhead moved onto the preview; awaiting 'seeked' (the frame painting). */
  Rendering,
}

export class ScrubController {
  private active = false;            // true between beginScrub() and endScrub()
  private cycle = Cycle.Idle;
  private latestFrame: number | null = null;
  private seq = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private wasPlaying = false;        // restore playback on endScrub()
  // True after we move currentTime ourselves (preview render or settle), so the resulting 'seeking'
  // event isn't mistaken for a user drag/seek. Consumed by the player's onVideoSeeking.
  private suppressSeeking = false;

  private hasStream = false;
  private duration = 0;
  private editRateNumerator = 25;
  private editRateDenominator = 1;

  constructor(
    private readonly video: HTMLVideoElement,
    /** Post a scrubPreview command to the worker for a dragged target frame. */
    private readonly requestPreview: (targetFrame: number, seq: number) => void,
    /** Settle accurately on the released position (decode preceding keyframe → exact frame). */
    private readonly settle: (timeSeconds: number) => void,
  ) {}

  /** True while a scrub is in progress (beginScrub→endScrub). */
  get isActive(): boolean {
    return this.active;
  }

  /** Record stream parameters once the manifest arrives (enables scrubTo/endScrub). */
  setStream(duration: number, editRateNumerator: number, editRateDenominator: number): void {
    this.hasStream = true;
    this.duration = duration;
    this.editRateNumerator = editRateNumerator;
    this.editRateDenominator = editRateDenominator;
  }

  /**
   * If the next 'seeking' event was caused by us moving currentTime (preview render / settle),
   * consume the suppression flag and report true so the player ignores that event.
   */
  consumeSuppressedSeeking(): boolean {
    if (!this.suppressSeeking) return false;
    this.suppressSeeking = false;
    return true;
  }

  /**
   * Enter scrub mode. The video is paused for the duration (scrub renders by seeking the paused
   * element onto each ready preview frame); endScrub() resumes playback if it was running.
   */
  beginScrub(): void {
    if (this.active) return;
    this.active = true;
    this.wasPlaying = !this.video.paused;
    this.video.pause();
  }

  /**
   * Report a live drag position (seconds). Records it as the newest target and kicks the
   * single-flight preview pump; does NOT touch video.currentTime (see beginScrub()).
   */
  scrubTo(timeSeconds: number): void {
    if (!this.hasStream || !this.active) return;
    const clamped = Math.max(0, Math.min(timeSeconds, this.duration));
    this.latestFrame = Math.round(clamped * this.editRateNumerator / this.editRateDenominator);
    this.pump();
  }

  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position). Moves
   * the playhead there, suppresses the resulting self-induced 'seeking', drives the accurate settle,
   * and resumes playback if it was running. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(timeSeconds?: number): void {
    if (!this.active) return;
    this.active = false;
    this.latestFrame = null; // stop the pump; an in-flight preview closes its cycle via onPreviewDone
    this.cycle = Cycle.Idle;
    this.clearWatchdog();
    if (!this.hasStream) return;
    const target = Math.max(0, Math.min(timeSeconds ?? this.video.currentTime, this.duration));
    // Move the playhead to the released position ourselves and suppress the resulting 'seeking'
    // event so it isn't double-handled — the accurate settle is driven explicitly below.
    this.suppressSeeking = target !== this.video.currentTime;
    this.video.currentTime = target;
    this.settle(target);
    if (this.wasPlaying) this.video.play().catch(() => {});
  }

  /**
   * A scrub preview's segment has been posted (and queued for append). `renderEditUnit` is the
   * keyframe the preview represents (from the worker) — seek THERE, into the contiguous run just
   * appended, not to the mid-GOP dragged target (which may be outside the short preview run). The
   * contiguous run is what lets a paused <video> paint. Wait for 'seeked' before the next cycle.
   */
  onPreviewDone(renderEditUnit: number): void {
    if (!this.active || this.cycle === Cycle.Idle || !this.hasStream) {
      this.cycle = Cycle.Idle;
      return;
    }
    const t = Math.max(0, Math.min(renderEditUnit * this.editRateDenominator / this.editRateNumerator, this.duration));
    if (Math.abs(t - this.video.currentTime) < 1e-3) { this.completeRender(); return; }
    this.cycle = Cycle.Rendering;
    this.suppressSeeking = true;
    this.video.currentTime = t;
    this.clearWatchdog();
    // A missing paint (e.g. a sparse isolated preview the paused element won't settle on) must not
    // wedge the cycle permanently.
    this.watchdog = setTimeout(() => this.completeRender(), 400);
  }

  /** The <video> fired 'seeked' — one signal a frame painted; complete the cycle if rendering. */
  onVideoSeeked(): void {
    if (this.active && this.cycle === Cycle.Rendering) this.completeRender();
  }

  /** Reset all state (file unload / destroy). */
  reset(): void {
    this.active = false;
    this.cycle = Cycle.Idle;
    this.latestFrame = null;
    this.clearWatchdog();
    this.seq = 0;
    this.suppressSeeking = false;
    this.wasPlaying = false;
    this.hasStream = false;
  }

  /** Start a cycle iff one isn't already running and a fresh dragged position is waiting. */
  private pump(): void {
    if (!this.active || this.cycle !== Cycle.Idle || this.latestFrame === null) return;
    const target = this.latestFrame;
    this.latestFrame = null;
    this.cycle = Cycle.Decoding;
    this.seq++;
    this.requestPreview(target, this.seq);
  }

  /** Seek completed (or watchdog) — advance to the freshest dragged position. */
  private completeRender(): void {
    this.clearWatchdog();
    this.cycle = Cycle.Idle;
    this.pump();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) { clearTimeout(this.watchdog); this.watchdog = null; }
  }
}
