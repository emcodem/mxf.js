/**
 * Web Audio PCM playback, slaved to the <video> clock.
 *
 * MSE generally cannot play raw PCM, so the worker decodes it to interleaved Float32 and posts it
 * here. The hard part is keeping that audio locked to the picture across cold start, seeks, scrubs,
 * stalls and pause — all of which move or freeze the <video> playhead independently of the
 * AudioContext clock. So this controller treats **`video.currentTime` as the master clock**: decoded
 * PCM is retained in a small time-addressed store, and a periodic look-ahead scheduler plays exactly
 * the audio that belongs to the current playhead.
 *
 * Reliability model:
 *  - **Master = the picture.** Audio for media time `m` is scheduled to sound when the <video> is at
 *    `m`. Whatever the element does (gate-paused on the first frame, seek, scrub, stall), the audio
 *    follows, because scheduling is gated on `!paused && !seeking` and re-locked to `currentTime`.
 *  - **Gapless forward play (no choppiness).** Within one play run the anchor (media→context-time
 *    mapping) is fixed, so consecutive chunks tile sample-exactly — we never re-anchor or re-cut
 *    audio that's already scheduled during steady play.
 *  - **Re-lock only on discontinuity.** A seek/scrub/pause stops scheduled audio immediately (so the
 *    pre-seek sound can't keep playing) and drops the anchor; the next tick re-locks to the new
 *    playhead. A slow clock drift beyond MAX_DRIFT is the only mid-run resync (rare; bounded).
 *
 * The single render/clock surface remains the <video> element; this controller only reads its
 * currentTime/paused/seeking and emits sound.
 */

interface AudioChunk {
  mediaStart: number;          // presentation time of the first sample (seconds)
  mediaEnd: number;            // mediaStart + duration
  duration: number;            // seconds
  samples: Float32Array;       // interleaved source samples (all channels)
  channelCount: number;
  sampleRate: number;
  source: AudioBufferSourceNode | null; // live node when scheduled, else null
  lastRun: number;             // scheduler run this chunk was last considered in (dedupes work)
  scheduledOnce: boolean;      // ever started a source (diag: distinguishes a missed chunk from retained history)
}

/** One diagnostics record. `t` is AudioContext wall time, `media` the relevant media time. */
interface DiagEvent {
  seq: number;                 // monotonic order key (stable sort)
  t: number;                   // cxt.currentTime when recorded (seconds)
  media: number;               // relevant media time (seconds)
  type: string;                // event kind (arrive, sched, drop, relock, stall, underrun, …)
  anomaly: boolean;            // true if this is a flagged, glitch-prone event
  detail: Record<string, unknown>;
}

const TICK_MS = 40;            // scheduler cadence
const LOOKAHEAD = 0.25;        // seconds of audio to schedule ahead of the playhead
const MAX_DRIFT = 0.08;        // resync if audio/picture diverge beyond this (hardware-clock drift)
const BACK_WINDOW = 2;         // retain this many seconds behind the playhead (scrub-back / re-mix)
const FWD_WINDOW = 30;         // evict chunks further ahead than this (orphans from abandoned seeks)

export class WebAudioController {
  private cxt: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Master gain every source routes through, so volume is one control point. Created with the context.
  private gainNode: GainNode | null = null;
  private volume = 1; // 0..1+, applied to gainNode (retained so setVolume works before the context exists)

  // media→context-time anchor: a chunk at media time m sounds at context time anchorCtx+(m-anchorMedia).
  private anchored = false;
  private anchorCtx = 0;
  private anchorMedia = 0;
  // Bumped on every (re)lock; chunks tag themselves with it so a run schedules each chunk at most once.
  private runId = 0;
  // Playhead-progress probe (media seconds vs AudioContext wall seconds) to detect a frozen playhead:
  // the element can rebuffer mid-play without going paused, and resyncing in place there would replay
  // the same audio on a loop. lastWall < 0 means "re-initialise" (set on every gate/pause).
  private lastWall = -1;
  private lastMedia = 0;

  // Decoded PCM retained for the buffered region, sorted by mediaStart. Bounded by BACK/FWD windows.
  private store: AudioChunk[] = [];

  private channelCount = 0;
  // Source channels (0-based) currently routed to the stereo output. Default: first pair (1+2).
  private active: number[] = [0, 1];
  private editRateNumerator = 25;
  private editRateDenominator = 1;

  // ── Diagnostics (opt-in via `diag`; zero cost when off) ──────────────────────────────────────
  // The scheduler decides everything silently, so an audible glitch normally leaves no trace. When
  // diag is on we record each decision into a ring, auto-warn on detectable anomalies, and let the
  // user dump the preceding ~DIAG_WINDOW seconds the instant they hear something (dumpDiag()).
  private static readonly DIAG_CAP = 512;          // ring-buffer size (events)
  private static readonly DIAG_WINDOW = 3;         // seconds of history a manual dump shows
  private diagBuf: DiagEvent[] = [];               // ring of recent events
  private diagHead = 0;                            // next write slot
  private diagSeq = 0;                             // monotonic order key
  private diagWarnAt: Record<string, number> = {}; // last warn time per type (rate-limit bursts)
  private schedCtxEnd = -1;                        // ctx-time end of the last started source (gap probe)
  private arriveDur = -1;                          // previous chunk's duration (sudden-change probe)
  private arriveCh = 0;                            // previous chunk's channel count (param-change probe)
  private arriveRate = 0;                          // previous chunk's sample rate (param-change probe)
  private seenEU = new Set<number>();              // edit units already received (duplicate probe)

  constructor(
    private readonly video: HTMLVideoElement,
    /** Fired when the channel count is first known or changes — lets the UI build a selector. */
    private readonly onAudioInfo: (info: { channelCount: number; activeChannels: number[] }) => void,
    /** Enable audio diagnostics (anomaly warnings + dumpDiag). Off = zero overhead. */
    private readonly diag = false,
  ) {}

  setEditRate(numerator: number, denominator: number): void {
    this.editRateNumerator = numerator;
    this.editRateDenominator = denominator;
  }

  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(sampleRate: number): void {
    this.cxt = new AudioContext({ sampleRate });
    this.gainNode = this.cxt.createGain();
    this.gainNode.gain.value = this.volume; // honour a volume set before the context existed
    this.gainNode.connect(this.cxt.destination);
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * Set the master output volume (0 = silent, 1 = unity; values >1 boost and may clip). Applied with a
   * short ramp to avoid a click, and retained so it survives a call made before audio (the context)
   * starts. Affects only the Web Audio PCM path — non-PCM audio plays through the muted <video>/MSE.
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, volume);
    if (this.gainNode && this.cxt)
      this.gainNode.gain.setTargetAtTime(this.volume, this.cxt.currentTime, 0.015);
  }

  hasContext(): boolean {
    return this.cxt !== null;
  }

  resume(): void {
    this.cxt?.resume().catch(() => {});
  }

  suspend(): void {
    this.cxt?.suspend().catch(() => {});
  }

  /** Stop audio at once and drop the anchor so the next tick re-locks to the live playhead. Call when
   *  the picture jumps or freezes outside the tick's view: seek/scrub start, and pause. The decoded
   *  store is kept (a seek may land in already-buffered audio). */
  onSeek(): void {
    this.unlock('seek');
  }

  /** Total number of PCM channels in the loaded file (0 until audio starts arriving). */
  get channels(): number {
    return this.channelCount;
  }

  /**
   * Contiguous decoded-PCM coverage ahead of `cur` (seconds): how far forward from the playhead the
   * store is tiled without a hole. Used by the player's resume gate so playback doesn't start on a
   * video-only buffer while the Web Audio path is still empty (the post-seek "video plays, audio
   * silent" dropout). Returns Infinity when Web Audio isn't the audible route (no context / MSE audio
   * / no audio track), so for those files it never constrains the gate. 0 means `cur` is uncovered.
   */
  bufferedAhead(cur: number): number {
    if (!this.cxt) return Infinity; // Web Audio not the audible path → not a gating constraint
    const eps = 0.5 * this.editRateDenominator / this.editRateNumerator;
    let end = -1;
    for (const c of this.store) {            // store is sorted by mediaStart
      if (end < 0) {
        if (c.mediaStart <= cur + 1e-6 && c.mediaEnd > cur) end = c.mediaEnd; // the chunk covering cur
      } else if (c.mediaStart - end <= eps) {
        end = c.mediaEnd;                    // contiguous continuation — extend coverage
      } else {
        break;                               // hole — coverage ends here
      }
    }
    return end < 0 ? 0 : Math.max(0, end - cur);
  }

  /** Source channels (0-based) currently routed to the stereo output. */
  get activeChannels(): number[] {
    return this.active.slice();
  }

  /**
   * Choose which source channels are played (0-based). Selected channels are mixed to stereo by
   * selection-order parity (1st→L, 2nd→R, 3rd→L…); a single channel plays centre; empty mutes.
   * Re-mixes the in-flight lookahead immediately so the change is effectively instant.
   */
  setActiveChannels(channels: number[]): void {
    this.active = [...new Set(channels.filter(c => Number.isInteger(c) && c >= 0))].sort((a, b) => a - b);
    // Re-mix already-scheduled audio with the new selection: stop the live sources and bump the run so
    // chunks reschedule (anchor unchanged → no resync, just a re-mix of ~LOOKAHEAD s). Re-pump NOW
    // instead of waiting up to TICK_MS for the next tick — that wait left the output silent between the
    // stop and the reschedule, an audible dropout on every channel toggle. The reschedule restarts the
    // chunk straddling the playhead at the current offset, so it's seamless. Only when actively playing
    // and anchored; paused/seeking/fast-motion is left for the next tick to re-lock as usual.
    this.stopSources();
    this.runId++;
    const v = this.video;
    if (this.anchored && this.cxt && !v.paused && !v.seeking && Math.abs(v.playbackRate - 1) <= 0.01)
      this.pump(v.currentTime);
  }

  /**
   * Record a (descriptor- or stream-derived) channel count, clamp the active selection to it, and
   * announce it. Used both at manifest time (before audio plays, so the UI can build a selector) and
   * when a decoded chunk's count differs from what we last announced.
   */
  applyChannelCount(count: number): void {
    if (count <= 0 || count === this.channelCount) return;
    this.channelCount = count;
    this.active = this.active.filter(c => c < count);
    if (this.active.length === 0) this.active = count >= 2 ? [0, 1] : [0];
    this.onAudioInfo({ channelCount: count, activeChannels: this.active.slice() });
  }

  /**
   * Store a decoded interleaved PCM chunk addressed by its media time (editUnit → seconds). It is NOT
   * played here — the look-ahead scheduler emits it when the <video> playhead reaches it, so audio
   * stays locked to the picture regardless of when this chunk happened to arrive.
   */
  schedule(samples: Float32Array, sampleRate: number, channelCount: number, editUnit: number): void {
    if (!this.cxt) return;
    this.applyChannelCount(channelCount);
    const samplesPerChannel = Math.floor(samples.length / channelCount);
    if (samplesPerChannel <= 0) return;

    const mediaStart = editUnit * this.editRateDenominator / this.editRateNumerator;
    const duration = samplesPerChannel / sampleRate;
    const chunk: AudioChunk = {
      mediaStart, mediaEnd: mediaStart + duration, duration,
      samples, channelCount, sampleRate, source: null, lastRun: -1, scheduledOnce: false,
    };
    if (this.diag) {
      this.rec('arrive', false, mediaStart, { eu: editUnit, dur: +duration.toFixed(5), ch: channelCount, rate: sampleRate });
      if (this.seenEU.has(editUnit)) this.rec('dup-eu', true, mediaStart, { eu: editUnit });
      else this.seenEU.add(editUnit);
      if (this.arriveRate && (channelCount !== this.arriveCh || sampleRate !== this.arriveRate))
        this.rec('param-change', true, mediaStart, { ch: channelCount, wasCh: this.arriveCh, rate: sampleRate, wasRate: this.arriveRate });
      // A chunk whose duration jumps from its neighbour's = a wrong sample count (a classic periodic
      // click). Tolerant of NTSC's 1601/1602 cadence (<0.1%); a truncated chunk stands well clear.
      if (this.arriveDur > 0 && Math.abs(duration - this.arriveDur) > this.arriveDur * 0.05)
        this.rec('dur-jump', true, mediaStart, { dur: +duration.toFixed(5), was: +this.arriveDur.toFixed(5), samples: samplesPerChannel });
      this.arriveDur = duration; this.arriveCh = channelCount; this.arriveRate = sampleRate;
    }
    this.insertChunk(chunk);
  }

  /** Insert sorted by mediaStart, evicting any retained chunk this fresh one OVERLAPS (its media span
   *  is being re-fetched). A re-fetch on a SHIFTED segment grid — e.g. the cold-start ramp on replay,
   *  or differing prefetch timing on a seek revisit — produces chunks whose boundaries don't line up
   *  with the retained ones. Keeping both scheduled the same audio twice (+6 dB); naively rejecting
   *  the new one instead left a coverage GAP at the old/new grid transition (an audible dropout). The
   *  fresh fetch is contiguous and current, so it WINS: drop the overlapped chunks (stopping any live
   *  source — they're ahead of the playhead, so not the one sounding now) and insert this one, letting
   *  the new grid tile the region seamlessly. Overlap uses a half-edit-unit tolerance so genuine
   *  tiling (chunk end == next chunk start, which jitters by ~1e-9 in float) is NOT treated as overlap. */
  private insertChunk(chunk: AudioChunk): void {
    const eps = 0.5 * this.editRateDenominator / this.editRateNumerator; // half an edit unit
    // Redundant re-fetch guard. Audio media-time is absolute (editUnit→seconds), so a chunk for a span
    // that is ALREADY contiguously resident carries identical PCM — it adds nothing. After a seek the
    // fetch frontier can sit behind the resident buffer (a revisited region), so the seek/forward fetch
    // re-produces 8→10 etc. that we already hold. Replacing resident chunks with these duplicates is
    // actively harmful: they arrive piecemeal (slow transcode), so removing the resident chunk opens a
    // hole the playhead falls into before the replacement lands — a mid-playback underrun (the ~500 ms
    // silence after a seek). Dropping the duplicate keeps the resident audio playing seamlessly. The
    // replace-on-overlap path below still runs for genuinely NEW/misaligned grids (not fully covered).
    if (this.isRegionResident(chunk.mediaStart, chunk.mediaEnd, eps)) {
      if (this.diag) this.rec('refetch-skip', false, chunk.mediaStart, { end: +chunk.mediaEnd.toFixed(3) });
      return;
    }
    for (let i = this.store.length - 1; i >= 0; i--) {
      const c = this.store[i];
      if (c.mediaEnd - chunk.mediaStart > eps && chunk.mediaEnd - c.mediaStart > eps) {
        if (c.source) { try { c.source.onended = null; c.source.stop(); } catch { /* already stopped */ } }
        this.store.splice(i, 1);
      }
    }
    let lo = 0, hi = this.store.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.store[mid].mediaStart < chunk.mediaStart) lo = mid + 1; else hi = mid;
    }
    this.store.splice(lo, 0, chunk);
    if (this.diag && lo > 0) {
      // Hole between this chunk and its predecessor (a tiling break, not a seek to a new region).
      const gap = chunk.mediaStart - this.store[lo - 1].mediaEnd;
      if (gap > eps && gap < 1) this.rec('coverage-gap', true, chunk.mediaStart, { gap: +gap.toFixed(4) });
    }
  }

  /** Debug: audio store summary "N:[s0-e0][s1-e1]…" (chunk count + each chunk's media span), so a gap
   *  or a short/diverged store is visible in the gate log. */
  debugStore(): string {
    if (!this.store.length) return '0:[]';
    let s = `${this.store.length}:`;
    for (const c of this.store) s += `[${c.mediaStart.toFixed(2)}-${c.mediaEnd.toFixed(2)}]`;
    return s;
  }

  /** True when [start, end) is already contiguously covered by chunks in the store, i.e. a fetch for
   *  this span would be redundant. `store` is sorted by mediaStart; walk from the chunk covering
   *  `start` and extend while tiles are contiguous (gap ≤ eps), succeeding as soon as reach ≥ end. */
  private isRegionResident(start: number, end: number, eps: number): boolean {
    let reach = -1;
    for (const c of this.store) {
      if (reach < 0) {
        if (c.mediaStart <= start + eps && c.mediaEnd > start) reach = c.mediaEnd; // chunk covering start
      } else if (c.mediaStart - reach <= eps) {
        reach = Math.max(reach, c.mediaEnd);                                       // contiguous tile
      } else {
        break;                                                                     // hole — give up
      }
      if (reach >= end - eps) return true;
    }
    return false;
  }

  /** Stop and clear all scheduled audio (e.g. on seek, so nothing keeps playing at the old offset). */
  private stopSources(): void {
    this.schedCtxEnd = -1; // the played-source chain is broken: the next start has no gap predecessor
    for (const c of this.store) {
      if (c.source) { try { c.source.onended = null; c.source.stop(); } catch { /* already stopped */ } c.source = null; }
    }
  }

  /** Stop audio and drop the anchor; a subsequent tick re-locks to the live playhead. */
  private unlock(reason = ''): void {
    if (this.diag) {
      this.rec('unlock', false, this.video.currentTime, { reason });
      // A seek/scrub/gate breaks the arrive history: the region after the jump is legitimately re-fetched
      // and may start on a partial chunk. Clear the per-chunk probes so they don't flag that replayed
      // region as dup-eu / dur-jump — phantom anomalies that would otherwise bury a real glitch.
      this.seenEU.clear();
      this.arriveDur = -1; this.arriveCh = 0; this.arriveRate = 0;
    }
    this.stopSources();
    this.anchored = false;
    this.runId++;
  }

  /** Periodic scheduler: keep ~LOOKAHEAD seconds of audio scheduled ahead of the <video> playhead. */
  private tick(): void {
    const cxt = this.cxt;
    if (!cxt) return;
    const v = this.video;
    const cur = v.currentTime;
    this.evict(cur);

    // Emit only while the picture is genuinely advancing at 1×, derived purely from the element's own
    // state — so audio follows playback no matter what started it (play(), the 'play' event, autoplay,
    // native controls). This single gate also makes audio follow the cold-start buffer gate (paused),
    // seeks/scrubs (seeking/paused) and stalls (paused) for free, and mutes during J/L fast-forward/
    // rewind (rate≠1) instead of thrashing on resync.
    if (v.paused || v.seeking || Math.abs(v.playbackRate - 1) > 0.01) {
      if (this.anchored) this.unlock('gate');
      this.lastWall = -1; // re-probe progress when playback resumes
      return;
    }

    // Stall detection: while supposedly playing, if the playhead isn't advancing in real time the
    // element is rebuffering (it can do so without going paused). Go silent and wait — resyncing in
    // place here would re-cut and replay the chunk over the frozen playhead, looping one audio frame.
    const wall = cxt.currentTime;
    if (this.lastWall >= 0) {
      const wallDelta = wall - this.lastWall;
      const mediaDelta = cur - this.lastMedia;
      if (wallDelta > 0.005 && mediaDelta < 0.25 * wallDelta) {
        this.rec('stall', true, cur, { wallDelta: +wallDelta.toFixed(3), mediaDelta: +mediaDelta.toFixed(3) });
        if (this.anchored) this.unlock('stall');
        this.lastWall = wall; this.lastMedia = cur;
        return;
      }
    }
    this.lastWall = wall; this.lastMedia = cur;

    if (!this.anchored) {
      this.lockTo(cur);
    } else {
      // Resync only on a real divergence (e.g. audio vs video hardware-clock drift). The audio sample
      // sounding now is at media time (cxt.currentTime - anchorCtx) + anchorMedia; compare to the
      // picture. Steady play stays well under MAX_DRIFT, so we never re-cut already-scheduled audio.
      const audioMediaNow = (wall - this.anchorCtx) + this.anchorMedia;
      if (Math.abs(audioMediaNow - cur) > MAX_DRIFT) this.lockTo(cur);
    }
    if (this.diag) {
      // Playing and anchored but no stored chunk covers the playhead → we've run out of audio (the
      // decode fell behind, or audio lags the picture after a seek). The decisive dropout signal.
      const covered = this.store.some(c => c.mediaStart <= cur + 1e-6 && c.mediaEnd > cur);
      if (!covered) this.rec('underrun', true, cur, { chunks: this.store.length });
    }
    this.pump(cur);
  }

  private lockTo(cur: number): void {
    // anomaly when already anchored: a mid-run resync (drift) stops & restarts sources → a click.
    if (this.diag) this.rec('relock', this.anchored, cur,
      { from: +this.anchorMedia.toFixed(3), drift: this.anchored ? +((this.cxt!.currentTime - this.anchorCtx) + this.anchorMedia - cur).toFixed(4) : 0 });
    this.stopSources();
    this.runId++;
    this.anchorCtx = this.cxt!.currentTime;
    this.anchorMedia = cur;
    this.anchored = true;
  }

  /** Schedule every not-yet-handled chunk whose window reaches into [cur, cur+LOOKAHEAD). */
  private pump(cur: number): void {
    const cxt = this.cxt!;
    const horizon = cur + LOOKAHEAD;
    const now = cxt.currentTime;
    for (const c of this.store) {
      if (c.mediaStart >= horizon) break;     // sorted: nothing further is in range
      if (c.lastRun === this.runId) continue; // already handled this run
      c.lastRun = this.runId;
      if (c.mediaEnd <= cur - 0.02) {         // fully behind the playhead
        // A never-played chunk reaching just behind the playhead = a chunk we missed (a gap). Retained
        // back-window history (already played, or well behind) is normal — don't flag it.
        if (this.diag && !c.scheduledOnce && cur - c.mediaEnd < 0.5)
          this.rec('drop', true, c.mediaStart, { reason: 'behind-unplayed', mediaEnd: +c.mediaEnd.toFixed(3) });
        continue;
      }

      const ctxStart = this.anchorCtx + (c.mediaStart - this.anchorMedia);
      const into = now - ctxStart;            // seconds already elapsed into this chunk
      if (into >= c.duration - 0.002) {        // missed its window (underrun) — drop
        if (this.diag && !c.scheduledOnce && into - c.duration < 0.5)
          this.rec('drop', true, c.mediaStart, { reason: 'missed', into: +into.toFixed(4), dur: +c.duration.toFixed(4) });
        continue;
      }
      const source = this.makeSource(c);
      if (!source) continue;
      if (into <= 0) source.start(ctxStart);  // future chunk: start at its exact time (gapless tile)
      else source.start(now, into);           // straddles the playhead: start now, offset in
      c.source = source;
      c.scheduledOnce = true;
      source.onended = () => { c.source = null; };
      if (this.diag) {
        // Consecutive sources should tile sample-exactly. A non-zero gap vs the previous source's
        // context-time end is an audible click (positive = silence, negative = overlap).
        const ctxEnd = into <= 0 ? ctxStart + c.duration : now + (c.duration - into);
        const gap = this.schedCtxEnd >= 0 ? ctxStart - this.schedCtxEnd : 0;
        this.rec('sched', this.schedCtxEnd >= 0 && Math.abs(gap) > 0.001, c.mediaStart,
          { mode: into <= 0 ? 'future' : 'straddle', gap: +gap.toFixed(5), ctxStart: +ctxStart.toFixed(4), ctxEnd: +ctxEnd.toFixed(4) });
        this.schedCtxEnd = ctxEnd;
      }
    }
  }

  /**
   * Mix a chunk's currently-active channels to a stereo AudioBuffer and wrap it in a source node.
   * Explicit mixing is more reliable than Web Audio's implicit down-mix (undefined for >6/non-standard
   * channel counts). Returns null if there is nothing to play (no active channels in range).
   *
   * Channels routed to the same side are SUMMED at unity gain (not averaged): a channel's loudness
   * must not change with how many other channels are selected. In broadcast files most of the N tracks
   * are silent or alternate feeds, so averaging by selection count (1/N) buried the program ~Nx when
   * "all" was selected; a unity sum keeps the program at the same level whether it's played alone or
   * alongside silent siblings. Genuinely-overlapping loud channels can exceed full scale, but Web Audio
   * clamps at the destination — acceptable, and the explicit intent here.
   */
  private makeSource(c: AudioChunk): AudioBufferSourceNode | null {
    const cxt = this.cxt!;
    const { samples, channelCount, sampleRate } = c;
    const samplesPerChannel = Math.floor(samples.length / channelCount);
    const sel = this.active.filter(ch => ch < channelCount);
    if (sel.length === 0) return null;
    const left: number[] = [], right: number[] = [];
    sel.forEach((ch, i) => (i % 2 === 0 ? left : right).push(ch));
    if (sel.length === 1) { right.length = 0; right.push(sel[0]); } // single channel → centre

    const buffer = cxt.createBuffer(2, samplesPerChannel, sampleRate);
    const mixInto = (out: Float32Array, chans: number[]): void => {
      if (chans.length === 0) return;
      for (let i = 0; i < samplesPerChannel; i++) {
        let acc = 0;
        const base = i * channelCount;
        for (const ch of chans) acc += samples[base + ch];
        out[i] = acc;
      }
    };
    mixInto(buffer.getChannelData(0), left);
    mixInto(buffer.getChannelData(1), right);

    const source = cxt.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode ?? cxt.destination); // through the master gain (volume)
    return source;
  }

  /** Drop chunks well behind or far ahead of the playhead to bound memory. */
  private evict(cur: number): void {
    if (this.store.length === 0) return;
    const kept: AudioChunk[] = [];
    for (const c of this.store) {
      if (c.mediaEnd < cur - BACK_WINDOW || c.mediaStart > cur + FWD_WINDOW) {
        if (c.source) { try { c.source.onended = null; c.source.stop(); } catch { /* already stopped */ } }
        continue;
      }
      kept.push(c);
    }
    this.store = kept;
  }

  // ── Diagnostics helpers ──────────────────────────────────────────────────────────────────────

  /** Record a diagnostic event into the ring (no-op unless diag is on). Anomalies also console.warn,
   *  rate-limited per type so one stutter can't produce a wall of logs. */
  private rec(type: string, anomaly: boolean, media: number, detail: Record<string, unknown>): void {
    if (!this.diag) return;
    const t = this.cxt ? this.cxt.currentTime : 0;
    this.diagBuf[this.diagHead] = { seq: this.diagSeq++, t, media, type, anomaly, detail };
    this.diagHead = (this.diagHead + 1) % WebAudioController.DIAG_CAP;
    if (anomaly) {
      const last = this.diagWarnAt[type] ?? -Infinity;
      if (t - last >= 0.2) {
        this.diagWarnAt[type] = t;
        // eslint-disable-next-line no-console
        console.warn(`[audio-diag] ${type} media=${media.toFixed(3)}s t=${t.toFixed(3)}s`, detail);
      }
    }
  }

  /**
   * Dump the recent scheduling history to the console — call the instant a glitch is heard. The ring
   * holds the preceding ~DIAG_WINDOW seconds, so the dump shows what happened just BEFORE the keypress
   * (where the glitch was). Includes a state snapshot and a boundary-sample probe: a large jump at a
   * tile join with no scheduling anomaly means the click is in the decoded data/mix, not the scheduler.
   */
  dumpDiag(label = ''): void {
    /* eslint-disable no-console */
    if (!this.diag) { console.warn('[audio-diag] diagnostics are off (construct WebAudioController with diag=true)'); return; }
    const now = this.cxt ? this.cxt.currentTime : 0;
    const v = this.video;
    const cur = v.currentTime;
    const events = this.diagBuf
      .filter((e): e is DiagEvent => !!e && now - e.t <= WebAudioController.DIAG_WINDOW)
      .sort((a, b) => a.seq - b.seq);
    const coverage = this.store.length
      ? { from: +this.store[0].mediaStart.toFixed(3), to: +this.store[this.store.length - 1].mediaEnd.toFixed(3), chunks: this.store.length }
      : { from: 0, to: 0, chunks: 0 };
    console.group(`[audio-diag] mark ${label} @ media=${cur.toFixed(3)}s t=${now.toFixed(3)}s (${events.length} events / ${WebAudioController.DIAG_WINDOW}s)`);
    console.log('state', {
      anchored: this.anchored, runId: this.runId, cxtState: this.cxt?.state,
      paused: v.paused, seeking: v.seeking, rate: v.playbackRate, active: this.active.slice(), coverage,
    });
    console.table(events.map(e => ({ dt: +(e.t - now).toFixed(3), type: e.type, media: +e.media.toFixed(3), anomaly: e.anomaly, ...e.detail })));
    const joins = this.boundaryProbe(cur);
    if (joins.length) { console.log('tile-join discontinuities (mixed output; large jump = click in data/mix):'); console.table(joins); }
    console.groupEnd();
    /* eslint-enable no-console */
  }

  /** Mixed-output discontinuity at each contiguous tile join near the playhead. A large jump = a click
   *  baked into the decoded PCM or the channel mix, not a scheduling fault. */
  private boundaryProbe(cur: number): Array<Record<string, number>> {
    const eps = 0.5 * this.editRateDenominator / this.editRateNumerator;
    const out: Array<Record<string, number>> = [];
    for (let i = 0; i + 1 < this.store.length; i++) {
      const a = this.store[i], b = this.store[i + 1];
      if (a.mediaEnd < cur - 1 || b.mediaStart > cur + 1) continue;  // only joins around the playhead
      if (Math.abs(b.mediaStart - a.mediaEnd) > eps) continue;       // not a contiguous tile join
      const lastA = this.mixFrame(a, Math.floor(a.samples.length / a.channelCount) - 1);
      const firstB = this.mixFrame(b, 0);
      out.push({ join: +a.mediaEnd.toFixed(3), jumpL: +Math.abs(lastA[0] - firstB[0]).toFixed(4), jumpR: +Math.abs(lastA[1] - firstB[1]).toFixed(4) });
    }
    return out;
  }

  /** The stereo [L,R] sample the active-channel mix produces for frame `i` of a chunk (mirrors makeSource). */
  private mixFrame(c: AudioChunk, i: number): [number, number] {
    const sel = this.active.filter(ch => ch < c.channelCount);
    if (sel.length === 0 || i < 0) return [0, 0];
    const left: number[] = [], right: number[] = [];
    sel.forEach((ch, k) => (k % 2 === 0 ? left : right).push(ch));
    if (sel.length === 1) { right.length = 0; right.push(sel[0]); }
    const base = i * c.channelCount;
    const sum = (chs: number[]): number => chs.reduce((acc, ch) => acc + c.samples[base + ch], 0);
    return [sum(left), sum(right)];
  }

  /** Tear down the AudioContext and reset all state for the next file. */
  destroy(): void {
    this.stopSources();
    this.store = [];
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cxt?.close().catch(() => {});
    this.cxt = null;
    this.gainNode = null; // recreated with the next context (this.volume carries the level over)
    this.anchored = false;
    this.channelCount = 0; // re-announced on the next file's first chunk
    // Reset diagnostics for the next file.
    this.diagBuf = []; this.diagHead = 0; this.diagSeq = 0; this.diagWarnAt = {};
    this.schedCtxEnd = -1; this.arriveDur = -1; this.arriveCh = 0; this.arriveRate = 0;
    this.seenEU.clear();
  }
}
