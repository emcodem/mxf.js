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
}

const TICK_MS = 40;            // scheduler cadence
const LOOKAHEAD = 0.25;        // seconds of audio to schedule ahead of the playhead
const MAX_DRIFT = 0.08;        // resync if audio/picture diverge beyond this (hardware-clock drift)
const BACK_WINDOW = 2;         // retain this many seconds behind the playhead (scrub-back / re-mix)
const FWD_WINDOW = 30;         // evict chunks further ahead than this (orphans from abandoned seeks)

export class WebAudioController {
  private cxt: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  // media→context-time anchor: a chunk at media time m sounds at context time anchorCtx+(m-anchorMedia).
  private anchored = false;
  private anchorCtx = 0;
  private anchorMedia = 0;
  // Bumped on every (re)lock; chunks tag themselves with it so a run schedules each chunk at most once.
  private runId = 0;

  // Decoded PCM retained for the buffered region, sorted by mediaStart. Bounded by BACK/FWD windows.
  private store: AudioChunk[] = [];

  private channelCount = 0;
  // Source channels (0-based) currently routed to the stereo output. Default: first pair (1+2).
  private active: number[] = [0, 1];
  private editRateNumerator = 25;
  private editRateDenominator = 1;

  constructor(
    private readonly video: HTMLVideoElement,
    /** Fired when the channel count is first known or changes — lets the UI build a selector. */
    private readonly onAudioInfo: (info: { channelCount: number; activeChannels: number[] }) => void,
  ) {}

  setEditRate(numerator: number, denominator: number): void {
    this.editRateNumerator = numerator;
    this.editRateDenominator = denominator;
  }

  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(sampleRate: number): void {
    this.cxt = new AudioContext({ sampleRate });
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
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
    this.unlock();
  }

  /** Total number of PCM channels in the loaded file (0 until audio starts arriving). */
  get channels(): number {
    return this.channelCount;
  }

  /** Source channels (0-based) currently routed to the stereo output. */
  get activeChannels(): number[] {
    return this.active.slice();
  }

  /**
   * Choose which source channels are played (0-based). Selected channels are mixed to stereo by
   * selection-order parity (1st→L, 2nd→R, 3rd→L…); a single channel plays centre; empty mutes.
   * Takes effect on the next tick (≤TICK_MS) by re-mixing the in-flight lookahead.
   */
  setActiveChannels(channels: number[]): void {
    this.active = [...new Set(channels.filter(c => Number.isInteger(c) && c >= 0))].sort((a, b) => a - b);
    // Re-mix already-scheduled audio: stop the live sources and bump the run so the next tick reschedules
    // the lookahead with the new selection (anchor unchanged → no resync, just a re-mix of ~LOOKAHEAD s).
    this.stopSources();
    this.runId++;
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
      samples, channelCount, sampleRate, source: null, lastRun: -1,
    };
    this.insertChunk(chunk);
  }

  /** Insert sorted by mediaStart, deduping a chunk we already hold for the same edit unit (re-fetch
   *  overlap on seek revisits would otherwise double the audio). */
  private insertChunk(chunk: AudioChunk): void {
    const half = 0.5 * this.editRateDenominator / this.editRateNumerator;
    let lo = 0, hi = this.store.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.store[mid].mediaStart < chunk.mediaStart) lo = mid + 1; else hi = mid;
    }
    const prev = this.store[lo - 1], next = this.store[lo];
    if ((prev && Math.abs(prev.mediaStart - chunk.mediaStart) < half) ||
        (next && Math.abs(next.mediaStart - chunk.mediaStart) < half)) return; // already have it
    this.store.splice(lo, 0, chunk);
  }

  /** Stop and clear all scheduled audio (e.g. on seek, so nothing keeps playing at the old offset). */
  private stopSources(): void {
    for (const c of this.store) {
      if (c.source) { try { c.source.onended = null; c.source.stop(); } catch { /* already stopped */ } c.source = null; }
    }
  }

  /** Stop audio and drop the anchor; a subsequent tick re-locks to the live playhead. */
  private unlock(): void {
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
      if (this.anchored) this.unlock();
      return;
    }

    if (!this.anchored) {
      this.lockTo(cur);
    } else {
      // Resync only on a real divergence (e.g. audio vs video hardware-clock drift). The audio sample
      // sounding now is at media time (cxt.currentTime - anchorCtx) + anchorMedia; compare to the
      // picture. Steady play stays well under MAX_DRIFT, so we never re-cut already-scheduled audio.
      const audioMediaNow = (cxt.currentTime - this.anchorCtx) + this.anchorMedia;
      if (Math.abs(audioMediaNow - cur) > MAX_DRIFT) this.lockTo(cur);
    }
    this.pump(cur);
  }

  private lockTo(cur: number): void {
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
      if (c.mediaEnd <= cur - 0.02) continue; // fully behind the playhead

      const ctxStart = this.anchorCtx + (c.mediaStart - this.anchorMedia);
      const into = now - ctxStart;            // seconds already elapsed into this chunk
      if (into >= c.duration - 0.002) continue; // missed its window (underrun) — drop
      const source = this.makeSource(c);
      if (!source) continue;
      if (into <= 0) source.start(ctxStart);  // future chunk: start at its exact time (gapless tile)
      else source.start(now, into);           // straddles the playhead: start now, offset in
      c.source = source;
      source.onended = () => { c.source = null; };
    }
  }

  /**
   * Mix a chunk's currently-active channels to a stereo AudioBuffer and wrap it in a source node.
   * Explicit mixing is more reliable than Web Audio's implicit down-mix (undefined for >6/non-standard
   * channel counts). Returns null if there is nothing to play (no active channels in range).
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
      const gain = 1 / chans.length;
      for (let i = 0; i < samplesPerChannel; i++) {
        let acc = 0;
        const base = i * channelCount;
        for (const ch of chans) acc += samples[base + ch];
        out[i] = acc * gain;
      }
    };
    mixInto(buffer.getChannelData(0), left);
    mixInto(buffer.getChannelData(1), right);

    const source = cxt.createBufferSource();
    source.buffer = buffer;
    source.connect(cxt.destination);
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

  /** Tear down the AudioContext and reset all state for the next file. */
  destroy(): void {
    this.stopSources();
    this.store = [];
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cxt?.close().catch(() => {});
    this.cxt = null;
    this.anchored = false;
    this.channelCount = 0; // re-announced on the next file's first chunk
  }
}
