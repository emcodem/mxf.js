class R {
  constructor() {
    this.listeners = /* @__PURE__ */ new Map();
  }
  on(e, t) {
    const i = String(e);
    return this.listeners.has(i) || this.listeners.set(i, /* @__PURE__ */ new Set()), this.listeners.get(i).add(t), this;
  }
  off(e, t) {
    var i;
    return (i = this.listeners.get(String(e))) == null || i.delete(t), this;
  }
  once(e, t) {
    const i = (s) => {
      t(s), this.off(e, i);
    };
    return this.on(e, i);
  }
  emit(e, t) {
    var i;
    (i = this.listeners.get(String(e))) == null || i.forEach((s) => {
      try {
        s(t);
      } catch {
      }
    });
  }
  removeAllListeners() {
    this.listeners.clear();
  }
}
const F = 1, P = 0.5, A = 3, D = 6, B = F + 0.5;
class b extends R {
  constructor(e, t = !1) {
    super(), this.mediaSource = null, this.objectURL = null, this.sourceBuffers = /* @__PURE__ */ new Map(), this.queues = /* @__PURE__ */ new Map(), this.processing = /* @__PURE__ */ new Map(), this.video = e, this.debug = t;
  }
  open(e, t) {
    return new Promise((i, s) => {
      this.mediaSource = new MediaSource(), this.objectURL = URL.createObjectURL(this.mediaSource), this.video.src = this.objectURL, this.mediaSource.addEventListener("sourceopen", () => {
        try {
          e && MediaSource.isTypeSupported(e) && this.addSourceBuffer("video", e), t && MediaSource.isTypeSupported(t) && this.addSourceBuffer("audio", t), i();
        } catch (r) {
          s(r);
        }
      }, { once: !0 }), this.mediaSource.addEventListener("error", () => s(new Error("MediaSource error")), { once: !0 });
    });
  }
  addSourceBuffer(e, t) {
    this.debug && console.log(`[mse] addSourceBuffer ${e} "${t}"`);
    const i = this.mediaSource.addSourceBuffer(t);
    this.sourceBuffers.set(e, i), this.queues.set(e, []), this.processing.set(e, !1), i.addEventListener("updateend", () => {
      this.processing.set(e, !1), this.emit("appended", { track: e }), this.drainQueue(e);
    }), i.addEventListener("error", () => {
      const s = `SourceBuffer error on ${e} track — codec may be unsupported or data is malformed`;
      console.error(`[mxf.js] ${s}`), this.emit("error", { track: e, message: s });
    });
  }
  appendSegment(e, t) {
    const i = this.queues.get(e);
    i && (i.push({ kind: "append", data: t }), this.drainQueue(e));
  }
  /** Queue a removal of buffered media in [start, end) for a track (used to cap buffer growth). */
  evict(e, t, i) {
    const s = this.queues.get(e);
    !s || i <= t || (s.push({ kind: "remove", start: t, end: i }), this.drainQueue(e));
  }
  /**
   * Evict already-played media older than `BACK_BUFFER_SECONDS` behind `currentTime` on every track,
   * keeping the resident buffer bounded. Called as playback advances. No-op if there's nothing old
   * enough to remove.
   */
  trimBackBuffer(e) {
    const t = e - D;
    if (!(t <= 0))
      for (const [i, s] of this.sourceBuffers) {
        if (s.buffered.length === 0) continue;
        const r = s.buffered.start(0);
        t > r + 0.5 && this.evict(i, r, t);
      }
  }
  /**
   * Evict buffered ranges that start more than `keepAheadSeconds` beyond `currentTime` on every
   * track. Heavy seeking (repeated ±N s skips, scrub previews) scatters small orphan ranges far
   * ahead of the playhead that back-buffer trimming never reaches (it only removes behind). Forward
   * fetching never fills past the buffer-ahead target, so any range starting well beyond it is an
   * abandoned-seek leftover — safe to drop, keeping the resident buffer bounded during heavy seeking.
   */
  trimForwardOrphans(e, t) {
    const i = e + t;
    for (const [s, r] of this.sourceBuffers)
      for (let a = r.buffered.length - 1; a >= 0; a--) {
        const n = r.buffered.start(a);
        n > i && this.evict(s, n, r.buffered.end(a));
      }
  }
  drainQueue(e) {
    if (this.processing.get(e)) return;
    const t = this.queues.get(e), i = this.sourceBuffers.get(e);
    if (!t || !i || t.length === 0 || i.updating) return;
    const s = t[0];
    this.processing.set(e, !0);
    try {
      if (s.kind === "append")
        t.shift(), i.appendBuffer(s.data);
      else {
        t.shift();
        const r = i.buffered.length ? i.buffered.start(0) : s.start, a = i.buffered.length ? i.buffered.end(i.buffered.length - 1) : s.end, n = Math.max(s.start, r), d = Math.min(s.end, a);
        d > n ? i.remove(n, d) : (this.processing.set(e, !1), this.drainQueue(e));
      }
    } catch (r) {
      this.processing.set(e, !1), s.kind === "append" && (r == null ? void 0 : r.name) === "QuotaExceededError" ? this.handleQuota(e, s.data) : console.error(`appendBuffer error (${e}):`, r);
    }
  }
  /**
   * The SourceBuffer is full. Free space by evicting media behind the playhead and retry the append.
   * If there's nothing behind to evict (the forward buffer alone is over quota — common for
   * high-bitrate all-intra like AVC-Intra), the segment can't be appended now: re-queue it at the
   * front and tell the player to stop fetching until the playhead advances and frees room.
   */
  handleQuota(e, t) {
    const i = this.sourceBuffers.get(e), s = this.queues.get(e);
    if (!i || !s) return;
    s.unshift({ kind: "append", data: t });
    const a = this.video.currentTime - 2, n = i.buffered.length ? i.buffered.start(0) : 0;
    i.buffered.length > 0 && a > n + 0.5 ? (s.unshift({ kind: "remove", start: n, end: a }), this.drainQueue(e)) : (this.debug && console.warn(`[mse] ${e} buffer full — pausing fetch until playhead advances`), this.emit("bufferfull", void 0));
  }
  setDuration(e) {
    if (this.mediaSource && this.mediaSource.readyState === "open")
      try {
        this.mediaSource.duration = e;
      } catch {
      }
  }
  endOfStream() {
    if (this.mediaSource && this.mediaSource.readyState === "open") {
      const e = () => {
        if ([...this.sourceBuffers.values()].some((i) => i.updating))
          setTimeout(e, 50);
        else
          try {
            this.mediaSource.endOfStream();
          } catch {
          }
      };
      e();
    }
  }
  /** Returns the current buffered end time in seconds for a given track */
  getBufferedEnd(e) {
    const t = this.sourceBuffers.get(e);
    return !t || t.buffered.length === 0 ? 0 : t.buffered.end(t.buffered.length - 1);
  }
  /**
   * Seconds of media buffered contiguously starting at `time`. Unlike getBufferedEnd this is
   * range-aware: if `time` is not inside any buffered range it returns 0 (data is needed here
   * now), and if it is, it returns the end of *that* range — not the end of some unrelated
   * later range. This is what fetch scheduling must use, otherwise a seek into an unbuffered
   * gap while a far-ahead range exists looks "buffered" and never fetches → permanent stall.
   */
  getBufferedAhead(e, t) {
    const i = this.sourceBuffers.get(e);
    if (!i || i.buffered.length === 0) return 0;
    for (let s = 0; s < i.buffered.length; s++) {
      const r = i.buffered.start(s), a = i.buffered.end(s);
      if (t >= r - 0.25 && t < a) return a - t;
    }
    return 0;
  }
  /** Returns the current buffered start time in seconds for a given track */
  getBufferedStart(e) {
    const t = this.sourceBuffers.get(e);
    return !t || t.buffered.length === 0 ? 0 : t.buffered.start(0);
  }
  hasVideoBuffer() {
    return this.sourceBuffers.has("video");
  }
  hasAudioBuffer() {
    return this.sourceBuffers.has("audio");
  }
  static isVideoTypeSupported(e) {
    return e === "h264" ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"') : MediaSource.isTypeSupported('video/mp4; codecs="mp4v.20.2"');
  }
  static isAudioTypeSupported(e) {
    return e === "aac" ? MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') : MediaSource.isTypeSupported('audio/mp4; codecs="ipcm"') || MediaSource.isTypeSupported('audio/mp4; codecs="sowt"');
  }
  static getMimeType(e, t) {
    if (e === "video") {
      if (t === "h264" || t.startsWith("avc1."))
        return `video/mp4; codecs="${t.startsWith("avc1.") ? t : "avc1.640033"}"`;
      if (t === "mpeg2") return 'video/mp4; codecs="mp4v.20.2"';
    }
    if (e === "audio") {
      if (t === "aac") return 'audio/mp4; codecs="mp4a.40.2"';
      if (t === "pcm")
        return MediaSource.isTypeSupported('audio/mp4; codecs="ipcm"') ? 'audio/mp4; codecs="ipcm"' : MediaSource.isTypeSupported('audio/mp4; codecs="sowt"') ? 'audio/mp4; codecs="sowt"' : null;
    }
    return null;
  }
  destroy() {
    if (this.objectURL && (URL.revokeObjectURL(this.objectURL), this.objectURL = null), this.mediaSource && this.mediaSource.readyState === "open")
      try {
        this.mediaSource.endOfStream();
      } catch {
      }
    this.video.src = "", this.mediaSource = null, this.sourceBuffers.clear(), this.queues.clear(), this.removeAllListeners();
  }
}
const L = 40, N = 0.25, I = 0.08, U = 2, W = 30, m = class m {
  // edit units already received (duplicate probe)
  constructor(e, t, i = !1) {
    this.video = e, this.onAudioInfo = t, this.diag = i, this.cxt = null, this.timer = null, this.gainNode = null, this.volume = 1, this.anchored = !1, this.anchorCtx = 0, this.anchorMedia = 0, this.runId = 0, this.lastWall = -1, this.lastMedia = 0, this.store = [], this.channelCount = 0, this.active = [0, 1], this.editRateNumerator = 25, this.editRateDenominator = 1, this.catchupRate = 1, this.diagBuf = [], this.diagHead = 0, this.diagSeq = 0, this.diagWarnAt = {}, this.diagCounts = {}, this._diagMaxSchedGap = 0, this.schedCtxEnd = -1, this.arriveDur = -1, this.arriveCh = 0, this.arriveRate = 0, this.seenEU = /* @__PURE__ */ new Set();
  }
  setEditRate(e, t) {
    this.editRateNumerator = e, this.editRateDenominator = t;
  }
  /**
   * Set the playback rate the scheduler should follow (1 = normal). The player calls this in lock-step
   * with setting video.playbackRate during live catch-up, so the tick gate's
   * `playbackRate ≈ catchupRate` test passes and audio keeps sounding (pitched up by `rate`) instead
   * of muting as it does for J/L scrub. A change re-locks: the media→context slope changes, so the
   * already-scheduled lookahead is stopped and the next tick re-anchors at the current playhead.
   */
  setCatchupRate(e) {
    const t = e > 0 ? e : 1;
    Math.abs(t - this.catchupRate) <= 1e-6 || (this.catchupRate = t, this.anchored && this.unlock("rate-change"));
  }
  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(e) {
    this.cxt = new AudioContext({ sampleRate: e }), this.gainNode = this.cxt.createGain(), this.gainNode.gain.value = this.volume, this.gainNode.connect(this.cxt.destination), this.timer || (this.timer = setInterval(() => this.tick(), L));
  }
  /**
   * Set the master output volume (0 = silent, 1 = unity; values >1 boost and may clip). Applied with a
   * short ramp to avoid a click, and retained so it survives a call made before audio (the context)
   * starts. Affects only the Web Audio PCM path — non-PCM audio plays through the muted <video>/MSE.
   */
  setVolume(e) {
    this.volume = Math.max(0, e), this.gainNode && this.cxt && this.gainNode.gain.setTargetAtTime(this.volume, this.cxt.currentTime, 0.015);
  }
  hasContext() {
    return this.cxt !== null;
  }
  resume() {
    var e;
    (e = this.cxt) == null || e.resume().catch(() => {
    });
  }
  suspend() {
    var e;
    (e = this.cxt) == null || e.suspend().catch(() => {
    });
  }
  /** Stop audio at once and drop the anchor so the next tick re-locks to the live playhead. Call when
   *  the picture jumps or freezes outside the tick's view: seek/scrub start, and pause. The decoded
   *  store is kept (a seek may land in already-buffered audio). */
  onSeek() {
    this.unlock("seek");
  }
  /** Total number of PCM channels in the loaded file (0 until audio starts arriving). */
  get channels() {
    return this.channelCount;
  }
  /**
   * Contiguous decoded-PCM coverage ahead of `cur` (seconds): how far forward from the playhead the
   * store is tiled without a hole. Used by the player's resume gate so playback doesn't start on a
   * video-only buffer while the Web Audio path is still empty (the post-seek "video plays, audio
   * silent" dropout). Returns Infinity when Web Audio isn't the audible route (no context / MSE audio
   * / no audio track), so for those files it never constrains the gate. 0 means `cur` is uncovered.
   */
  bufferedAhead(e) {
    if (!this.cxt) return 1 / 0;
    const t = 0.5 * this.editRateDenominator / this.editRateNumerator;
    let i = -1;
    for (const s of this.store)
      if (i < 0)
        s.mediaStart <= e + 1e-6 && s.mediaEnd > e && (i = s.mediaEnd);
      else if (s.mediaStart - i <= t)
        i = s.mediaEnd;
      else
        break;
    return i < 0 ? 0 : Math.max(0, i - e);
  }
  /** Source channels (0-based) currently routed to the stereo output. */
  get activeChannels() {
    return this.active.slice();
  }
  /**
   * Choose which source channels are played (0-based). Selected channels are mixed to stereo by
   * selection-order parity (1st→L, 2nd→R, 3rd→L…); a single channel plays centre; empty mutes.
   * Re-mixes the in-flight lookahead immediately so the change is effectively instant.
   */
  setActiveChannels(e) {
    this.active = [...new Set(e.filter((i) => Number.isInteger(i) && i >= 0))].sort((i, s) => i - s), this.stopSources(), this.runId++;
    const t = this.video;
    this.anchored && this.cxt && !t.paused && !t.seeking && Math.abs(t.playbackRate - this.catchupRate) <= 0.01 && this.pump(t.currentTime);
  }
  /**
   * Record a (descriptor- or stream-derived) channel count, clamp the active selection to it, and
   * announce it. Used both at manifest time (before audio plays, so the UI can build a selector) and
   * when a decoded chunk's count differs from what we last announced.
   */
  applyChannelCount(e) {
    e <= 0 || e === this.channelCount || (this.channelCount = e, this.active = this.active.filter((t) => t < e), this.active.length === 0 && (this.active = e >= 2 ? [0, 1] : [0]), this.onAudioInfo({ channelCount: e, activeChannels: this.active.slice() }));
  }
  /**
   * Store a decoded interleaved PCM chunk addressed by its media time (editUnit → seconds). It is NOT
   * played here — the look-ahead scheduler emits it when the <video> playhead reaches it, so audio
   * stays locked to the picture regardless of when this chunk happened to arrive.
   */
  schedule(e, t, i, s) {
    if (!this.cxt) return;
    this.applyChannelCount(i);
    const r = Math.floor(e.length / i);
    if (r <= 0) return;
    const a = s * this.editRateDenominator / this.editRateNumerator, n = r / t, d = {
      mediaStart: a,
      mediaEnd: a + n,
      duration: n,
      samples: e,
      channelCount: i,
      sampleRate: t,
      source: null,
      lastRun: -1,
      scheduledOnce: !1
    };
    this.diag && (this.rec("arrive", !1, a, { eu: s, dur: +n.toFixed(5), ch: i, rate: t }), this.seenEU.has(s) ? this.rec("dup-eu", !0, a, { eu: s }) : this.seenEU.add(s), this.arriveRate && (i !== this.arriveCh || t !== this.arriveRate) && this.rec("param-change", !0, a, { ch: i, wasCh: this.arriveCh, rate: t, wasRate: this.arriveRate }), this.arriveDur > 0 && Math.abs(n - this.arriveDur) > this.arriveDur * 0.05 && this.rec("dur-jump", !0, a, { dur: +n.toFixed(5), was: +this.arriveDur.toFixed(5), samples: r }), this.arriveDur = n, this.arriveCh = i, this.arriveRate = t), this.insertChunk(d);
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
  insertChunk(e) {
    const t = 0.5 * this.editRateDenominator / this.editRateNumerator;
    if (this.isRegionResident(e.mediaStart, e.mediaEnd, t)) {
      this.diag && this.rec("refetch-skip", !1, e.mediaStart, { end: +e.mediaEnd.toFixed(3) });
      return;
    }
    for (let r = this.store.length - 1; r >= 0; r--) {
      const a = this.store[r];
      if (a.mediaEnd - e.mediaStart > t && e.mediaEnd - a.mediaStart > t) {
        if (a.source)
          try {
            a.source.onended = null, a.source.stop();
          } catch {
          }
        this.store.splice(r, 1);
      }
    }
    let i = 0, s = this.store.length;
    for (; i < s; ) {
      const r = i + s >> 1;
      this.store[r].mediaStart < e.mediaStart ? i = r + 1 : s = r;
    }
    if (this.store.splice(i, 0, e), this.diag && i > 0) {
      const r = e.mediaStart - this.store[i - 1].mediaEnd;
      r > t && r < 1 && this.rec("coverage-gap", !0, e.mediaStart, { gap: +r.toFixed(4) });
    }
  }
  /** Debug: audio store summary "N:[s0-e0][s1-e1]…" (chunk count + each chunk's media span), so a gap
   *  or a short/diverged store is visible in the gate log. */
  debugStore() {
    if (!this.store.length) return "0:[]";
    let e = `${this.store.length}:`;
    for (const t of this.store) e += `[${t.mediaStart.toFixed(2)}-${t.mediaEnd.toFixed(2)}]`;
    return e;
  }
  /** True when [start, end) is already contiguously covered by chunks in the store, i.e. a fetch for
   *  this span would be redundant. `store` is sorted by mediaStart; walk from the chunk covering
   *  `start` and extend while tiles are contiguous (gap ≤ eps), succeeding as soon as reach ≥ end. */
  isRegionResident(e, t, i) {
    let s = -1;
    for (const r of this.store) {
      if (s < 0)
        r.mediaStart <= e + i && r.mediaEnd > e && (s = r.mediaEnd);
      else if (r.mediaStart - s <= i)
        s = Math.max(s, r.mediaEnd);
      else
        break;
      if (s >= t - i) return !0;
    }
    return !1;
  }
  /** Stop and clear all scheduled audio (e.g. on seek, so nothing keeps playing at the old offset). */
  stopSources() {
    this.schedCtxEnd = -1;
    for (const e of this.store)
      if (e.source) {
        try {
          e.source.onended = null, e.source.stop();
        } catch {
        }
        e.source = null;
      }
  }
  /** Stop audio and drop the anchor; a subsequent tick re-locks to the live playhead. */
  unlock(e = "") {
    this.diag && (this.rec("unlock", !1, this.video.currentTime, { reason: e }), this.seenEU.clear(), this.arriveDur = -1, this.arriveCh = 0, this.arriveRate = 0), this.stopSources(), this.anchored = !1, this.runId++;
  }
  /** Periodic scheduler: keep ~LOOKAHEAD seconds of audio scheduled ahead of the <video> playhead. */
  tick() {
    const e = this.cxt;
    if (!e) return;
    const t = this.video, i = t.currentTime, s = this.catchupRate;
    if (this.evict(i), t.paused || t.seeking || Math.abs(t.playbackRate - s) > 0.01) {
      this.anchored && this.unlock("gate"), this.lastWall = -1;
      return;
    }
    const r = e.currentTime;
    if (this.lastWall >= 0) {
      const a = r - this.lastWall, n = i - this.lastMedia;
      if (a > 5e-3 && n < 0.25 * s * a) {
        this.rec("stall", !0, i, { wallDelta: +a.toFixed(3), mediaDelta: +n.toFixed(3) }), this.anchored && this.unlock("stall"), this.lastWall = r, this.lastMedia = i;
        return;
      }
    }
    if (this.lastWall = r, this.lastMedia = i, !this.anchored)
      this.lockTo(i);
    else {
      const a = (r - this.anchorCtx) * s + this.anchorMedia;
      Math.abs(a - i) > I && this.lockTo(i);
    }
    this.diag && (this.store.some((n) => n.mediaStart <= i + 1e-6 && n.mediaEnd > i) || this.rec("underrun", !0, i, { chunks: this.store.length })), this.pump(i);
  }
  lockTo(e) {
    this.diag && this.rec(
      "relock",
      this.anchored,
      e,
      { from: +this.anchorMedia.toFixed(3), drift: this.anchored ? +(this.cxt.currentTime - this.anchorCtx + this.anchorMedia - e).toFixed(4) : 0 }
    ), this.stopSources(), this.runId++, this.anchorCtx = this.cxt.currentTime, this.anchorMedia = e, this.anchored = !0;
  }
  /** Schedule every not-yet-handled chunk whose window reaches into [cur, cur+LOOKAHEAD). */
  pump(e) {
    const t = this.cxt, i = this.catchupRate, s = e + N, r = t.currentTime;
    for (const a of this.store) {
      if (a.mediaStart >= s) break;
      if (a.lastRun === this.runId) continue;
      if (a.lastRun = this.runId, a.mediaEnd <= e - 0.02) {
        this.diag && !a.scheduledOnce && e - a.mediaEnd < 0.5 && this.rec("drop", !0, a.mediaStart, { reason: "behind-unplayed", mediaEnd: +a.mediaEnd.toFixed(3) });
        continue;
      }
      const n = a.duration / i, d = this.anchorCtx + (a.mediaStart - this.anchorMedia) / i, o = r - d;
      if (o >= n - 2e-3) {
        this.diag && !a.scheduledOnce && o - n < 0.5 && this.rec("drop", !0, a.mediaStart, { reason: "missed", into: +o.toFixed(4), dur: +n.toFixed(4) });
        continue;
      }
      const c = this.makeSource(a);
      if (c && (c.playbackRate.value = i, o <= 0 ? c.start(d) : c.start(r, o * i), a.source = c, a.scheduledOnce = !0, c.onended = () => {
        a.source = null;
      }, this.diag)) {
        const l = o <= 0 ? d + n : r + (n - o), u = this.schedCtxEnd >= 0 ? d - this.schedCtxEnd : 0;
        this.rec(
          "sched",
          this.schedCtxEnd >= 0 && Math.abs(u) > 1e-3,
          a.mediaStart,
          { mode: o <= 0 ? "future" : "straddle", gap: +u.toFixed(5), ctxStart: +d.toFixed(4), ctxEnd: +l.toFixed(4) }
        ), Math.abs(u) > Math.abs(this._diagMaxSchedGap) && (this._diagMaxSchedGap = u), this.schedCtxEnd = l;
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
  makeSource(e) {
    const t = this.cxt, { samples: i, channelCount: s, sampleRate: r } = e, a = Math.floor(i.length / s), n = this.active.filter((f) => f < s);
    if (n.length === 0) return null;
    const d = [], o = [];
    n.forEach((f, g) => (g % 2 === 0 ? d : o).push(f)), n.length === 1 && (o.length = 0, o.push(n[0]));
    const c = t.createBuffer(2, a, r), l = (f, g) => {
      if (g.length !== 0)
        for (let v = 0; v < a; v++) {
          let x = 0;
          const T = v * s;
          for (const w of g) x += i[T + w];
          f[v] = x;
        }
    };
    l(c.getChannelData(0), d), l(c.getChannelData(1), o);
    const u = t.createBufferSource();
    return u.buffer = c, u.connect(this.gainNode ?? t.destination), u;
  }
  /** Drop chunks well behind or far ahead of the playhead to bound memory. */
  evict(e) {
    if (this.store.length === 0) return;
    const t = [];
    for (const i of this.store) {
      if (i.mediaEnd < e - U || i.mediaStart > e + W) {
        if (i.source)
          try {
            i.source.onended = null, i.source.stop();
          } catch {
          }
        continue;
      }
      t.push(i);
    }
    this.store = t;
  }
  // ── Diagnostics helpers ──────────────────────────────────────────────────────────────────────
  /** Record a diagnostic event into the ring (no-op unless diag is on). Anomalies also console.warn,
   *  rate-limited per type so one stutter can't produce a wall of logs. */
  rec(e, t, i, s) {
    if (!this.diag) return;
    t && (this.diagCounts[e] = (this.diagCounts[e] ?? 0) + 1);
    const r = this.cxt ? this.cxt.currentTime : 0;
    if (this.diagBuf[this.diagHead] = { seq: this.diagSeq++, t: r, media: i, type: e, anomaly: t, detail: s }, this.diagHead = (this.diagHead + 1) % m.DIAG_CAP, t) {
      const a = this.diagWarnAt[e] ?? -1 / 0;
      r - a >= 0.2 && (this.diagWarnAt[e] = r, console.warn(`[audio-diag] ${e} media=${i.toFixed(3)}s t=${r.toFixed(3)}s`, s));
    }
  }
  /**
   * Dump the recent scheduling history to the console — call the instant a glitch is heard. The ring
   * holds the preceding ~DIAG_WINDOW seconds, so the dump shows what happened just BEFORE the keypress
   * (where the glitch was). Includes a state snapshot and a boundary-sample probe: a large jump at a
   * tile join with no scheduling anomaly means the click is in the decoded data/mix, not the scheduler.
   */
  /**
   * DIAG (remove after debug): a sampler-friendly snapshot of the live audio↔picture relationship.
   * `avOffset` = the media time the audio is SOUNDING now minus video.currentTime (the perceived
   * async): ~0 = locked, |large| = audio ahead(+)/behind(−) the picture. Audio relocks at 80 ms, so a
   * sustained large value should be impossible — if the user hears async while this stays ~0, the
   * PICTURE is mislabeled (a worker/decoder issue), not the audio scheduler. `counts` are cumulative
   * per-anomaly totals (NOT rate-limited like the console warns), so a sampler sees true glitch
   * frequency. `coverAhead` = contiguous decoded audio ahead of the playhead (0 = about to underrun).
   */
  diagSnapshot() {
    const e = this.video.currentTime, t = this.anchored && this.cxt ? (this.cxt.currentTime - this.anchorCtx) * this.catchupRate + this.anchorMedia - e : NaN, i = this._diagMaxSchedGap;
    return this._diagMaxSchedGap = 0, {
      avOffset: Number.isFinite(t) ? +t.toFixed(4) : NaN,
      anchored: this.anchored,
      coverAhead: +this.bufferedAhead(e).toFixed(3),
      rate: this.catchupRate,
      chunks: this.store.length,
      maxSchedGap: +i.toFixed(5),
      counts: { ...this.diagCounts }
    };
  }
  dumpDiag(e = "") {
    var d;
    if (!this.diag) {
      console.warn("[audio-diag] diagnostics are off (construct WebAudioController with diag=true)");
      return;
    }
    const t = this.cxt ? this.cxt.currentTime : 0, i = this.video, s = i.currentTime, r = this.diagBuf.filter((o) => !!o && t - o.t <= m.DIAG_WINDOW).sort((o, c) => o.seq - c.seq), a = this.store.length ? { from: +this.store[0].mediaStart.toFixed(3), to: +this.store[this.store.length - 1].mediaEnd.toFixed(3), chunks: this.store.length } : { from: 0, to: 0, chunks: 0 };
    console.group(`[audio-diag] mark ${e} @ media=${s.toFixed(3)}s t=${t.toFixed(3)}s (${r.length} events / ${m.DIAG_WINDOW}s)`), console.log("state", {
      anchored: this.anchored,
      runId: this.runId,
      cxtState: (d = this.cxt) == null ? void 0 : d.state,
      paused: i.paused,
      seeking: i.seeking,
      rate: i.playbackRate,
      active: this.active.slice(),
      coverage: a
    }), console.table(r.map((o) => ({ dt: +(o.t - t).toFixed(3), type: o.type, media: +o.media.toFixed(3), anomaly: o.anomaly, ...o.detail })));
    const n = this.boundaryProbe(s);
    n.length && (console.log("tile-join discontinuities (mixed output; large jump = click in data/mix):"), console.table(n)), console.groupEnd();
  }
  /** Mixed-output discontinuity at each contiguous tile join near the playhead. A large jump = a click
   *  baked into the decoded PCM or the channel mix, not a scheduling fault. */
  boundaryProbe(e) {
    const t = 0.5 * this.editRateDenominator / this.editRateNumerator, i = [];
    for (let s = 0; s + 1 < this.store.length; s++) {
      const r = this.store[s], a = this.store[s + 1];
      if (r.mediaEnd < e - 1 || a.mediaStart > e + 1 || Math.abs(a.mediaStart - r.mediaEnd) > t) continue;
      const n = this.mixFrame(r, Math.floor(r.samples.length / r.channelCount) - 1), d = this.mixFrame(a, 0);
      i.push({ join: +r.mediaEnd.toFixed(3), jumpL: +Math.abs(n[0] - d[0]).toFixed(4), jumpR: +Math.abs(n[1] - d[1]).toFixed(4) });
    }
    return i;
  }
  /** The stereo [L,R] sample the active-channel mix produces for frame `i` of a chunk (mirrors makeSource). */
  mixFrame(e, t) {
    const i = this.active.filter((d) => d < e.channelCount);
    if (i.length === 0 || t < 0) return [0, 0];
    const s = [], r = [];
    i.forEach((d, o) => (o % 2 === 0 ? s : r).push(d)), i.length === 1 && (r.length = 0, r.push(i[0]));
    const a = t * e.channelCount, n = (d) => d.reduce((o, c) => o + e.samples[a + c], 0);
    return [n(s), n(r)];
  }
  /** Tear down the AudioContext and reset all state for the next file. */
  destroy() {
    var e;
    this.stopSources(), this.store = [], this.timer && (clearInterval(this.timer), this.timer = null), (e = this.cxt) == null || e.close().catch(() => {
    }), this.cxt = null, this.gainNode = null, this.anchored = !1, this.catchupRate = 1, this.channelCount = 0, this.diagBuf = [], this.diagHead = 0, this.diagSeq = 0, this.diagWarnAt = {}, this.schedCtxEnd = -1, this.arriveDur = -1, this.arriveCh = 0, this.arriveRate = 0, this.seenEU.clear();
  }
};
m.DIAG_CAP = 512, m.DIAG_WINDOW = 3;
let k = m;
class $ {
  constructor(e, t, i, s) {
    this.video = e, this.requestPreview = t, this.settle = i, this.resume = s, this.active = !1, this.cycle = 0, this.latestFrame = null, this.seq = 0, this.watchdog = null, this.wasPlaying = !1, this.suppressSeeking = !1, this.hasStream = !1, this.duration = 0, this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  /** True while a scrub is in progress (beginScrub→endScrub). */
  get isActive() {
    return this.active;
  }
  /** Record stream parameters once the manifest arrives (enables scrubTo/endScrub). */
  setStream(e, t, i) {
    this.hasStream = !0, this.duration = e, this.editRateNumerator = t, this.editRateDenominator = i;
  }
  /**
   * If the next 'seeking' event was caused by us moving currentTime (preview render / settle),
   * consume the suppression flag and report true so the player ignores that event.
   */
  consumeSuppressedSeeking() {
    return this.suppressSeeking ? (this.suppressSeeking = !1, !0) : !1;
  }
  /**
   * Enter scrub mode. The video is paused for the duration (scrub renders by seeking the paused
   * element onto each ready preview frame); endScrub() resumes playback if it was running.
   */
  beginScrub() {
    this.active || (this.active = !0, this.wasPlaying = !this.video.paused, this.video.pause());
  }
  /**
   * Report a live drag position (seconds). Records it as the newest target and kicks the
   * single-flight preview pump; does NOT touch video.currentTime (see beginScrub()).
   */
  scrubTo(e) {
    if (!this.hasStream || !this.active) return;
    const t = Math.max(0, Math.min(e, this.duration));
    this.latestFrame = Math.round(t * this.editRateNumerator / this.editRateDenominator), this.pump();
  }
  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position). Moves
   * the playhead there, suppresses the resulting self-induced 'seeking', drives the accurate settle,
   * and resumes playback if it was running. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(e) {
    if (!this.active || (this.active = !1, this.latestFrame = null, this.cycle = 0, this.clearWatchdog(), !this.hasStream)) return;
    const t = Math.max(0, Math.min(e ?? this.video.currentTime, this.duration));
    this.suppressSeeking = t !== this.video.currentTime, this.video.currentTime = t, this.settle(t), this.wasPlaying && this.resume();
  }
  /**
   * A scrub preview's segment has been posted (and queued for append). `renderEditUnit` is the
   * keyframe the preview represents (from the worker) — seek THERE, into the contiguous run just
   * appended, not to the mid-GOP dragged target (which may be outside the short preview run). The
   * contiguous run is what lets a paused <video> paint. Wait for 'seeked' before the next cycle.
   */
  onPreviewDone(e) {
    if (!this.active || this.cycle === 0 || !this.hasStream) {
      this.cycle = 0;
      return;
    }
    const t = Math.max(0, Math.min(e * this.editRateDenominator / this.editRateNumerator, this.duration));
    if (Math.abs(t - this.video.currentTime) < 1e-3) {
      this.completeRender();
      return;
    }
    this.cycle = 2, this.suppressSeeking = !0, this.video.currentTime = t, this.clearWatchdog(), this.watchdog = setTimeout(() => this.completeRender(), 400);
  }
  /** The <video> fired 'seeked' — one signal a frame painted; complete the cycle if rendering. */
  onVideoSeeked() {
    this.active && this.cycle === 2 && this.completeRender();
  }
  /** Reset all state (file unload / destroy). */
  reset() {
    this.active = !1, this.cycle = 0, this.latestFrame = null, this.clearWatchdog(), this.seq = 0, this.suppressSeeking = !1, this.wasPlaying = !1, this.hasStream = !1;
  }
  /** Start a cycle iff one isn't already running and a fresh dragged position is waiting. */
  pump() {
    if (!this.active || this.cycle !== 0 || this.latestFrame === null) return;
    const e = this.latestFrame;
    this.latestFrame = null, this.cycle = 1, this.seq++, this.requestPreview(e, this.seq);
  }
  /** Seek completed (or watchdog) — advance to the freshest dragged position. */
  completeRender() {
    this.clearWatchdog(), this.cycle = 0, this.pump();
  }
  clearWatchdog() {
    this.watchdog !== null && (clearTimeout(this.watchdog), this.watchdog = null);
  }
}
function S(h) {
  return (h < 10 ? "0" : "") + h;
}
function y(h, e) {
  return e && (h === 30 || h === 60);
}
function E(h) {
  return h === 60 ? 4 : 2;
}
function G(h) {
  const e = h.base;
  if (e <= 0) return 0;
  let t = ((h.hours * 60 + h.minutes) * 60 + h.seconds) * e + h.frames;
  if (y(e, h.dropFrame)) {
    const i = E(e), s = h.hours * 60 + h.minutes;
    t -= i * (s - Math.floor(s / 10));
  }
  return t;
}
function M(h, e, t) {
  if (e <= 0) return { hours: 0, minutes: 0, seconds: 0, frames: 0, dropFrame: !1, base: e };
  let i = h < 0 ? 0 : Math.floor(h);
  const s = y(e, t);
  if (s) {
    const o = E(e), c = e * 600 - o * 9, l = e * 60 - o, u = Math.floor(i / c), f = i % c;
    i += o * 9 * u + (f > o ? o * Math.floor((f - o) / l) : 0);
  }
  const r = i % e, a = Math.floor(i / e) % 60, n = Math.floor(i / (e * 60)) % 60;
  return { hours: Math.floor(i / (e * 3600)) % 24, minutes: n, seconds: a, frames: r, dropFrame: s, base: e };
}
function C(h) {
  const e = y(h.base, h.dropFrame) ? ";" : ":";
  return `${S(h.hours)}:${S(h.minutes)}:${S(h.seconds)}${e}${S(h.frames)}`;
}
function O(h, e = 0) {
  if (h.length < 4) return null;
  const t = (h[0] & 15) + (h[0] >> 4 & 3) * 10, i = (h[0] & 64) !== 0, s = (h[1] & 15) + (h[1] >> 4 & 7) * 10, r = (h[2] & 15) + (h[2] >> 4 & 7) * 10;
  return { hours: (h[3] & 15) + (h[3] >> 4 & 3) * 10, minutes: r, seconds: s, frames: t, dropFrame: i, base: e };
}
const q = {
  mpeg2video: "mpeg2",
  h264: "h264",
  libx264: "h264"
};
function p(h) {
  const e = h.mxfCodec ?? q[h.ffmpegCodec] ?? h.ffmpegCodec;
  return { moduleUrl: h.moduleUrl, ffmpegCodec: h.ffmpegCodec, mxfCodec: e };
}
const _ = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: "auto",
  seekMode: "accurate",
  resumeBufferSeconds: B,
  debug: !1,
  live: !1,
  liveCatchupStrategy: "speed",
  catchupRate: 1.1,
  catchupStartSeconds: 5,
  catchupStopSeconds: 2,
  catchupJumpSeconds: 15,
  plugins: {}
};
class V extends R {
  constructor(e, t = {}) {
    super(), this.worker = null, this.mseController = null, this.manifest = null, this.nextFetchFrame = 0, this.framesPerChunk = 50, this.rampChunkFrames = 50, this.fetchPending = !1, this.bufferFull = !1, this.editRateNumerator = 25, this.editRateDenominator = 1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.liveMode = !1, this.liveAtEdge = !1, this.liveStallPolls = 0, this.LIVE_POLL_MS = 1e3, this.LIVE_STALL_MAX = 3, this.livePollTimer = null, this.standbyWorker = null, this.standbyReady = !1, this.standbyManifest = null, this.standbyListener = null, this.standbyInitSegment = null, this.reanchorPending = !1, this.switching = !1, this.pendingNextUrl = null, this.liveEndEmitted = !1, this.catchupActive = !1, this.catchupJumpPending = !1, this.reportedLagSeconds = 0, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.rvfcHandle = 0, this.destroyed = !1, this.video = e, this.config = { ..._, ...t }, this.audio = new k(this.video, (i) => this.emit("audio-info", i), !!this.config.debug), this.scrub = new $(
      this.video,
      (i, s) => {
        var r;
        return (r = this.worker) == null ? void 0 : r.postMessage({ type: "scrubPreview", targetFrame: i, seq: s });
      },
      (i) => this.initiateSeek(i, "accurate"),
      () => this.play()
    ), this.video.addEventListener("seeking", () => this.onVideoSeeking()), this.video.addEventListener("seeked", () => this.onVideoSeeked()), this.video.addEventListener("timeupdate", () => this.onTimeUpdate()), this.video.addEventListener("waiting", () => this.onVideoWaiting()), this.video.addEventListener("playing", () => {
      this.startupGating = !1, this.setBuffering(!1);
    }), this.video.addEventListener("canplay", () => this.maybeResumePlayback()), this.video.addEventListener("play", () => {
      this.playIntent = !0, this.audio.resume(), this.startupGating && !this.video.paused && this.bufferedAhead() < this.resumeTargetSeconds() && (this.video.pause(), this.maybeResumePlayback());
    }), this.startVideoFrameCallback();
  }
  startVideoFrameCallback() {
    const e = this.video;
    if (typeof e.requestVideoFrameCallback != "function") return;
    const t = (i, s) => {
      this.destroyed || (this.updateTimecode(s.mediaTime), this.rvfcHandle = e.requestVideoFrameCallback(t));
    };
    this.rvfcHandle = e.requestVideoFrameCallback(t);
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
  updateTimecode(e) {
    if (!this.manifest) return;
    const t = this.editRateNumerator / this.editRateDenominator;
    if (!(t > 0)) return;
    const i = Math.max(0, Math.floor(e * t + 1e-6));
    if (i === this.lastTimecodeEditUnit) return;
    this.lastTimecodeEditUnit = i;
    const s = this.computeTimecodeBundle(i);
    this.currentTimecodeBundle = s, this.emit("timecode", s);
  }
  /** System Item timecode at a presentation edit unit: nearest preceding anchor + linear offset. */
  systemTimecodeAt(e) {
    let t = null;
    for (const s of this.systemAnchors)
      s.editUnit <= e && (!t || s.editUnit > t.editUnit) && (t = s);
    if (!t) return null;
    const i = t.frameCount + (e - t.editUnit);
    return C(M(i, t.base, t.dropFrame));
  }
  /** Build the full timecode bundle (system + computed package TCs) for a rendered edit unit. */
  computeTimecodeBundle(e) {
    var d;
    const t = [], i = this.systemTimecodeAt(e);
    i !== null && t.push({ source: "system", text: i, reliable: !0 });
    const s = ((d = this.manifest) == null ? void 0 : d.indexMode) !== "none", r = this.editRateNumerator / this.editRateDenominator;
    for (const o of this.manifestTimecodes) {
      const c = o.editRateDenominator > 0 ? o.editRateNumerator / o.editRateDenominator : r, l = r > 0 ? Math.round(e * (c / r)) : e, u = C(M(o.position + l, o.base, o.dropFrame));
      t.push({ source: o.source, text: u, reliable: s });
    }
    const a = { system: 0, material: 1, source: 2, file: 3 };
    t.sort((o, c) => a[o.source] - a[c.source]);
    const n = t.length ? { source: t[0].source, text: t[0].text } : null;
    return { editUnit: e, primary: n, all: t };
  }
  /** The most recently computed timecode bundle for the frame on screen (null before playback). */
  get currentTimecode() {
    return this.currentTimecodeBundle;
  }
  /** Merge fresh System Item anchors, keeping the list sorted/deduped by edit unit and bounded. */
  mergeSystemAnchors(e) {
    for (const i of e) {
      const s = this.systemAnchors.findIndex((r) => r.editUnit === i.editUnit);
      s >= 0 ? this.systemAnchors[s] = i : this.systemAnchors.push(i);
    }
    this.systemAnchors.sort((i, s) => i.editUnit - s.editUnit);
    const t = 4096;
    this.systemAnchors.length > t && this.systemAnchors.splice(0, this.systemAnchors.length - t);
  }
  get currentTime() {
    return this.video.currentTime;
  }
  get duration() {
    var e;
    return ((e = this.manifest) == null ? void 0 : e.duration) ?? 0;
  }
  get paused() {
    return this.video.paused;
  }
  /**
   * True when playback is held/stalled waiting for more data (the first picture may be visible but
   * the playhead isn't advancing). Mirrors the `buffering` event; poll this or listen to the event
   * to drive a "Buffering…" indicator.
   */
  get buffering() {
    return this.isBuffering;
  }
  /**
   * Which seeking strategy the loaded file supports, or null before the manifest arrives:
   * 'cbg' (constant-byte-count math), 'vbe' (per-frame index entries), or 'none' (growing/live —
   * approximate offset-percentage seeking). Useful for tailoring UI (e.g. exact vs approximate seek).
   */
  get indexMode() {
    var e;
    return ((e = this.manifest) == null ? void 0 : e.indexMode) ?? null;
  }
  /** Active picture dimensions of the loaded video (the real frame, not the per-field StoredHeight),
   *  or null before the manifest arrives. Pair with {@link aspectRatio} for the displayed shape. */
  get videoDimensions() {
    return this.manifest ? { width: this.manifest.displayWidth, height: this.manifest.displayHeight } : null;
  }
  /** Display aspect ratio (DAR) of the loaded video, e.g. `{num:16,den:9}`, or null for square
   *  pixels / before the manifest. The picture is already rendered at this shape. */
  get aspectRatio() {
    var e;
    return ((e = this.manifest) == null ? void 0 : e.aspectRatio) ?? null;
  }
  play() {
    this.previewParked && this.manifest && this.initiateSeek(this.video.currentTime, "accurate"), this.playIntent = !0, this.startupGating = !0, this.audio.resume(), this.maybeResumePlayback();
  }
  pause() {
    this.playIntent = !1, this.video.pause(), this.audio.onSeek(), this.setBuffering(!1);
  }
  /** Seek to a time in seconds. The <video> 'seeking' event drives the worker fetch. No-op in live
   *  mode (the timeline is open-ended and playback only streams forward). */
  seek(e) {
    if (!this.manifest || this.liveMode) return;
    const t = Math.max(0, Math.min(e, this.manifest.duration));
    this.video.currentTime = t;
  }
  /**
   * Enter scrub mode. While scrubbing, feed the live drag position to `scrubTo()` (e.g. from a
   * slider's `input` event); each position triggers a fast GOP-head preview. Crucially, the drag
   * does NOT move the <video> playhead — that only happens once a preview is buffered, so the
   * picture keeps updating instead of stalling on positions whose frame hasn't arrived yet. The
   * video is paused for the duration (scrub renders by seeking the paused element onto each ready
   * preview frame); endScrub() resumes playback if it was running.
   */
  beginScrub() {
    var e;
    (e = this.worker) == null || e.postMessage({ type: "cancelPrefetch" }), this.fetchPending = !1, this.audio.onSeek(), this.scrub.beginScrub();
  }
  /**
   * Report a live drag position (seconds) during scrubbing. Records it as the newest target and
   * kicks the single-flight preview pump; does NOT touch video.currentTime (see beginScrub()).
   */
  scrubTo(e) {
    this.indexMode !== "none" && this.scrub.scrubTo(e);
  }
  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position):
   * decodes the preceding keyframe up to the exact target so the final picture is precise, then
   * resumes normal forward fetching (and playback, if it was running). Call on the slider's
   * `change` event. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(e) {
    this.scrub.endScrub(e);
  }
  /** Total number of PCM audio channels in the loaded file (0 until audio starts arriving). */
  get audioChannels() {
    return this.audio.channels;
  }
  /** Source channels (0-based) currently routed to the stereo output. */
  get activeChannels() {
    return this.audio.activeChannels;
  }
  /**
   * Choose which source audio channels are played. Indices are 0-based. The selected channels are
   * mixed down to the stereo output by selection-order parity (1st→L, 2nd→R, 3rd→L, …); a single
   * selected channel plays centre. Takes effect on subsequently scheduled audio (within the current
   * audio buffer-ahead). Passing an empty array mutes audio.
   */
  setAudioChannels(e) {
    this.audio.setActiveChannels(e);
  }
  /**
   * Set the master audio volume: 0 = silent, 1 = unity (default); values above 1 boost and may clip.
   * Applies to the Web Audio PCM path (the only audible path — the <video> element is muted). Safe to
   * call before playback starts; the level is retained and applied once the audio context exists.
   */
  setVolume(e) {
    this.audio.setVolume(e);
  }
  /**
   * Diagnostics: dump the recent audio-scheduling history to the console — call the instant a glitch
   * is heard. Only does anything when the player was created with `debug: true` (which enables audio
   * diagnostics). See WebAudioController.dumpDiag for the dump format.
   */
  markAudioGlitch(e = "") {
    this.audio.dumpDiag(e);
  }
  /** DIAG (remove after debug): live audio↔picture snapshot for an external sampler — the perceived
   *  A/V offset (avOffset), audio coverage ahead, and cumulative anomaly counts. See
   *  WebAudioController.diagSnapshot. */
  audioDiag() {
    return this.audio.diagSnapshot();
  }
  loadUrl(e) {
    var s;
    this.setup();
    const t = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: p(this.config.plugins.videoDecoder) } : void 0, i = { type: "initUrl", url: e, debug: this.config.debug, videoMode: "mse", plugins: t };
    this.worker.postMessage(i);
  }
  /**
   * Open a still-growing recording as a live stream: start near the file's current end, follow it
   * forward, and emit 'live-end' when it completes (call {@link switchLive}/{@link preloadNextUrl} to
   * continue with the next file). No seeking/scrubbing while live. The index is ignored (frames are
   * streamed straight forward), so this works for any codec/index. `startEditUnit` is 0 for the first
   * file; rotated files inherit a continuous counter automatically on switch.
   */
  loadLive(e) {
    var s;
    this.setup();
    const t = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: p(this.config.plugins.videoDecoder) } : void 0, i = { type: "initUrl", url: e, debug: this.config.debug, videoMode: "mse", plugins: t, live: !0, startEditUnit: 0, liveFromStart: !1 };
    this.worker.postMessage(i);
  }
  loadFile(e) {
    var s;
    this.setup();
    const t = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: p(this.config.plugins.videoDecoder) } : void 0, i = { type: "initFile", file: e, debug: this.config.debug, videoMode: "mse", plugins: t };
    this.worker.postMessage(i);
  }
  /** Create + wire a fresh MseController. Shared by setup() and the clean live re-anchor
   *  (reanchorToStandby), so both behave identically. */
  createMseController() {
    this.mseController = new b(this.video, !!this.config.debug), this.mseController.on("error", ({ track: e, message: t }) => {
      this.emit("error", { message: `MSE ${e}: ${t}`, fatal: !1 });
    }), this.mseController.on("bufferfull", () => {
      this.bufferFull = !0, this.fetchPending = !1;
    }), this.mseController.on("appended", ({ track: e }) => {
      e === "video" && this.playIntent && this.video.paused && this.maybeResumePlayback();
    });
  }
  setup() {
    this.destroyInternal(), this.worker = this.createWorker(), this.attachWorkerListeners(this.worker), this.createMseController();
  }
  createWorker() {
    const e = new URL("./demux-worker.js", import.meta.url);
    return new Worker(e, { type: "module" });
  }
  /** Wire the message / error / messageerror handlers onto a worker. Shared by setup() and the
   *  standby→active worker swap (activateStandby), so the new live worker behaves identically. */
  attachWorkerListeners(e) {
    e.addEventListener("message", (t) => this.onWorkerMessage(t.data)), e.addEventListener("error", (t) => {
      var s;
      const i = [
        t.message,
        t.filename && `${t.filename}:${t.lineno ?? "?"}:${t.colno ?? "?"}`,
        (s = t.error) == null ? void 0 : s.stack
      ].filter(Boolean).join(" — ");
      console.error("[mxf.js] worker error:", t, t.error), this.emit("error", {
        message: i || "Worker failed to load — reload the page (the dev server may have restarted)",
        fatal: !0
      });
    }), e.addEventListener("messageerror", (t) => {
      this.emit("error", { message: `Worker message error: ${String(t)}`, fatal: !0 });
    });
  }
  async onWorkerMessage(e) {
    var t, i, s, r, a;
    switch (e.type) {
      case "manifest":
        await this.onManifest(e);
        break;
      case "initSegment":
        (t = this.mseController) != null && t.hasVideoBuffer() || (i = this.mseController) != null && i.hasAudioBuffer() ? (this.mseController.appendSegment("video", e.data), this.mseController.appendSegment("audio", e.data), this.fetchNextChunk()) : this.pendingInitSegment = e.data;
        break;
      case "videoSegment":
        (s = this.mseController) == null || s.appendSegment("video", e.data), (r = e.systemTcAnchors) != null && r.length && this.mergeSystemAnchors(e.systemTcAnchors), e.nextFrame !== void 0 && !this.scrub.isActive && !this.previewParked && (this.nextFetchFrame = e.nextFrame), this.playIntent && this.video.paused && this.maybeResumePlayback();
        break;
      case "audioSegment":
        (a = this.mseController) == null || a.appendSegment("audio", e.data);
        break;
      case "pcmSamples":
        this.emit("pcm-audio", {
          samples: e.samples,
          sampleRate: e.sampleRate,
          channelCount: e.channelCount,
          editUnit: e.editUnit
        }), this.audio.schedule(e.samples, e.sampleRate, e.channelCount, e.editUnit);
        break;
      case "segmentDone":
        this.fetchPending = !1, this.fetchNextChunk();
        break;
      case "seeked": {
        if (this.pendingSeeks = Math.max(0, this.pendingSeeks - 1), this.pendingSeeks > 0) break;
        const n = e.nearestKeyframeEditUnit;
        if (this.nextFetchFrame = n, this.fetchPending = !1, this.activeSeekMode === "keyframe") {
          const o = Math.max(e.gopFrameCount, this.seekTargetFrame - n + 1, 1);
          this.fetchKeyframePreview(n, o);
          break;
        }
        const d = Math.min(
          this.framesPerChunk,
          Math.max(1, this.seekTargetFrame - n + 3)
        );
        this.fetchNextChunk(d);
        break;
      }
      case "previewDone":
        this.scrub.onPreviewDone(e.editUnit);
        break;
      case "liveUpdate":
        this.onLiveUpdate(e);
        break;
      case "liveTailFlushed":
        this.switching && (this.nextFetchFrame = e.nextEditUnit, this.activateStandby());
        break;
      case "codecUnsupported":
        this.emit("codec-unsupported", { codec: e.codec, reason: e.reason });
        break;
      case "error":
        this.emit("error", { message: e.message, fatal: e.fatal });
        break;
    }
  }
  async onManifest(e) {
    var o, c;
    const t = e.pictureDescriptor, i = e.soundDescriptor;
    this.liveMode = e.live ?? !1, this.liveAtEdge = !1, this.liveStallPolls = 0;
    const s = this.liveMode ? 1 / 0 : e.duration;
    this.editRateNumerator = e.editRateNumerator, this.editRateDenominator = e.editRateDenominator, this.audio.setEditRate(e.editRateNumerator, e.editRateDenominator), this.scrub.setStream(e.duration, e.editRateNumerator, e.editRateDenominator);
    const r = e.editRateNumerator / e.editRateDenominator;
    this.framesPerChunk = Math.ceil(r * F), this.rampChunkFrames = Math.max(A, Math.ceil(r * P)), this.startupGating = !0, this.manifestTimecodes = e.timecodes ?? [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.manifest = {
      duration: s,
      editRateNumerator: e.editRateNumerator,
      editRateDenominator: e.editRateDenominator,
      tracks: e.tracks,
      pictureDescriptor: t,
      soundDescriptor: i,
      displayWidth: e.displayWidth,
      displayHeight: e.displayHeight,
      aspectRatio: e.aspectRatio,
      indexMode: e.indexMode,
      longGop: e.longGop,
      timecodes: e.timecodes ?? [],
      live: this.liveMode
    };
    const a = e.resolvedVideoCodec ?? (t == null ? void 0 : t.codec) ?? "unknown", n = t && e.videoCodecSupported ? b.getMimeType("video", a) : null;
    let d = i ? b.getMimeType("audio", i.codec) : null;
    (i == null ? void 0 : i.codec) === "pcm" && (this.config.pcmAudioMode === "webaudio" || !d) && (d = null, this.audio.createContext(i.sampleRate)), this.audio.applyChannelCount(e.audioChannelCount);
    try {
      await this.mseController.open(n, d);
    } catch (l) {
      this.emit("error", { message: `MSE open failed: ${l}`, fatal: !0 });
      return;
    }
    this.mseController.setDuration(s), this.pendingInitSegment ? ((o = this.mseController) == null || o.appendSegment("video", this.pendingInitSegment), (c = this.mseController) == null || c.appendSegment("audio", this.pendingInitSegment), this.pendingInitSegment = null, this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${i == null ? void 0 : i.codec}`), this.fetchNextChunk()) : (this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${i == null ? void 0 : i.codec}`));
  }
  /**
   * Fetch a single I-frame at `keyframe` for a fast scrub preview, telling the worker to stretch
   * that one decoded sample across `stretchFrames` frame periods so it covers its whole GOP on the
   * MSE timeline. Posted directly (not via fetchNextChunk) so it isn't gated by the scrub guard.
   */
  fetchKeyframePreview(e, t) {
    if (!this.manifest) return;
    this.previewParked = !0, this.nextFetchFrame = e;
    const i = {
      type: "fetchSegment",
      startFrame: e,
      frameCount: 1,
      seqBase: this.seqBase,
      stretchToFrames: t
    };
    this.seqBase += 2, this.worker.postMessage(i);
  }
  fetchNextChunk(e) {
    var d;
    if (this.scrub.isActive || this.previewParked || this.bufferFull || this.fetchPending || !this.manifest) return;
    const t = this.video.currentTime, i = this.editRateNumerator / this.editRateDenominator;
    if (this.nextFetchFrame / i - t >= this.config.maxBufferSeconds) return;
    if (this.liveMode) {
      if (this.liveAtEdge) {
        this.scheduleLivePoll();
        return;
      }
      const o = e ?? this.nextRampChunk();
      this.fetchPending = !0, this.worker.postMessage({ type: "fetchSegment", startFrame: this.nextFetchFrame, frameCount: o, seqBase: this.seqBase }), this.seqBase += 2;
      return;
    }
    const r = Math.round(
      this.manifest.duration * this.editRateNumerator / this.editRateDenominator
    );
    if (this.nextFetchFrame >= r) {
      (d = this.mseController) == null || d.endOfStream();
      return;
    }
    const a = e ?? this.nextRampChunk();
    this.fetchPending = !0;
    const n = {
      type: "fetchSegment",
      startFrame: this.nextFetchFrame,
      frameCount: a,
      seqBase: this.seqBase
    };
    this.seqBase += 2, this.nextFetchFrame += a, this.worker.postMessage(n);
  }
  /** Return the current cold-start ramp size, then grow it ×2 toward framesPerChunk. A fresh load
   *  ramps ~0.25 s → 0.5 s → 1 s → 2 s so the first paint is fast without a big first download, then
   *  settles at the full chunk. Reset per file in onManifest. */
  nextRampChunk() {
    const e = this.rampChunkFrames;
    return this.rampChunkFrames = Math.min(this.framesPerChunk, this.rampChunkFrames * 2), e;
  }
  onVideoSeeking() {
    if (!this.manifest || this.liveMode || this.scrub.consumeSuppressedSeeking()) return;
    const e = this.video.currentTime;
    if (this.emit("seeking", { targetTime: e }), this.scrub.isActive) {
      this.scrub.scrubTo(e);
      return;
    }
    if (!this.previewParked && this.isSeekServedByBuffer(e)) {
      this.audio.onSeek();
      return;
    }
    this.initiateSeek(e, this.config.seekMode);
  }
  /**
   * True when `targetTime` is already buffered contiguously up to (or past) the forward-fetch
   * frontier, so a seek there needs no worker work: the element paints the frame from the existing
   * buffer, and when playback later drains to the end of that range, forward fetching resumes exactly
   * there (nextFetchFrame) with no gap. If the containing range ends before the frontier (a gap
   * between here and where we'd resume fetching), this returns false and a real seek is required.
   */
  isSeekServedByBuffer(e) {
    if (!this.mseController || !this.manifest) return !1;
    const t = this.mseController.getBufferedAhead("video", e);
    if (t <= 0) return !1;
    const i = this.audio.bufferedAhead(e);
    if (i <= 0) return !1;
    const s = this.editRateNumerator / this.editRateDenominator, r = Math.min(this.nextFetchFrame / s, this.manifest.duration) - 0.5;
    return e + t >= r && e + i >= r;
  }
  onVideoSeeked() {
    this.scrub.onVideoSeeked();
  }
  initiateSeek(e, t) {
    if (!this.manifest) return;
    this.fetchPending = !0, this.startupGating = !0, this.video.paused || (this.video.pause(), this.setBuffering(!0)), this.activeSeekMode = t, this.previewParked = !1, this.bufferFull = !1, this.seekTargetFrame = Math.round(
      e * this.editRateNumerator / this.editRateDenominator
    ), this.pendingSeeks++, this.audio.onSeek();
    const i = { type: "seek", targetFrame: this.seekTargetFrame };
    this.worker.postMessage(i);
  }
  onTimeUpdate() {
    var i, s, r;
    if (!this.manifest) return;
    const e = this.video.currentTime;
    this.scrub.isActive || ((i = this.mseController) == null || i.trimBackBuffer(e), (s = this.mseController) == null || s.trimForwardOrphans(e, this.config.maxBufferSeconds + 5), this.bufferFull = !1), (((r = this.mseController) == null ? void 0 : r.getBufferedAhead("video", e)) ?? 0) < this.config.startBufferSeconds && (this.previewParked && !this.video.paused && !this.scrub.isActive ? this.initiateSeek(e, "accurate") : this.fetchNextChunk()), this.emit("timeupdate", { currentTime: e, duration: this.duration }), this.updateTimecode(e), this.liveMode && this.evaluateCatchup();
  }
  /** Buffered-ahead seconds of video at the current playhead (0 if unknown). */
  bufferedAhead() {
    var e;
    return ((e = this.mseController) == null ? void 0 : e.getBufferedAhead("video", this.video.currentTime)) ?? 0;
  }
  /** Seconds of forward buffer required before (re)starting playback: RESUME_BUFFER_SECONDS, capped at
   *  what remains to the end so the final fraction of a clip can still start. Shared by the startup
   *  gate (maybeResumePlayback) and the autoplay/native-start interception in the 'play' handler. */
  resumeTargetSeconds() {
    const e = Math.max(0, this.duration - this.video.currentTime);
    return Math.min(this.config.resumeBufferSeconds, Math.max(0, e - 0.05));
  }
  /** Update + emit the buffering state, but only when it actually changes. */
  setBuffering(e) {
    this.isBuffering !== e && (this.isBuffering = e, this.emit("buffering", { buffering: e, bufferedSeconds: this.bufferedAhead() }));
  }
  /**
   * Single decision point for starting/holding playback. Called from play(), after each appended
   * video segment, on 'canplay', and from the stall handler. If the user wants to play and the
   * element is paused: start it once at least RESUME_BUFFER_SECONDS is buffered ahead (or we've
   * fetched to EOF / are within that of the end); otherwise hold, show "buffering", and keep
   * fetching. The first decoded picture is already painted by the paused element, so the viewer sees
   * the frame immediately while the buffer fills — no cold-start stutter, no silent post-seek freeze.
   */
  maybeResumePlayback() {
    if (!this.playIntent || !this.manifest || this.scrub.isActive) return;
    if (this.pendingSeeks > 0) {
      this.setBuffering(!0);
      return;
    }
    if (!this.video.paused) {
      this.setBuffering(!1);
      return;
    }
    const e = this.editRateNumerator / this.editRateDenominator, t = Math.round(this.manifest.duration * e), i = this.nextFetchFrame >= t, s = this.resumeTargetSeconds(), r = this.audio.bufferedAhead(this.video.currentTime), a = this.bufferedAhead(), n = this.nextFetchFrame / e - this.video.currentTime, d = i || n >= this.config.maxBufferSeconds, o = a >= s && (r >= s || d) || i;
    this.config.debug && this.log(`gate cur=${this.video.currentTime.toFixed(2)} v=${a.toFixed(2)} a=${r === 1 / 0 ? "inf" : r.toFixed(2)} target=${s.toFixed(2)} eof=${i} pending=${this.pendingSeeks} reqAhead=${n.toFixed(2)} stuck=${d} → ${o ? "PLAY" : "hold"} vbuf=${this.videoRanges()} abuf=${this.audio.debugStore()}`), o ? (this.startupGating = !1, this.setBuffering(!1), this.video.play().catch(() => {
    })) : (this.setBuffering(!0), this.fetchNextChunk());
  }
  /**
   * The element ran out of buffered data mid-playback ('waiting'). Rather than let it resume the
   * instant a single frame arrives (which produces the stutter), pause it and re-buffer through
   * maybeResumePlayback() so it resumes once cleanly. Ignored while scrubbing / parked on a preview
   * (those manage the element themselves) or when the user has paused.
   */
  onVideoWaiting() {
    !this.playIntent || this.scrub.isActive || this.previewParked || (this.config.debug && this.log(`waiting cur=${this.video.currentTime.toFixed(2)} gating=${this.startupGating} pending=${this.pendingSeeks} vbuf=${this.videoRanges()}`), this.setBuffering(!0), this.startupGating && (this.video.pause(), this.maybeResumePlayback()));
  }
  // ── Live mode ────────────────────────────────────────────────────────────────
  /**
   * Worker forward-frontier / edge report (replaces segmentDone for live). Adopts the authoritative
   * forward frontier (continuous edit unit), tracks the edge/stall state, switches to the next file
   * when the current one completes, and keeps the forward buffer topped up.
   */
  onLiveUpdate(e) {
    if (this.liveMode) {
      if (this.switching) {
        this.fetchPending = !1;
        return;
      }
      if (this.fetchPending = !1, this.nextFetchFrame = e.nextEditUnit, this.liveAtEdge = e.atEdge, e.atEdge) {
        if (this.liveStallPolls = e.grew ? 0 : this.liveStallPolls + 1, this.maybeCompleteLive()) return;
        this.scheduleLivePoll();
      } else
        this.liveStallPolls = 0;
      this.playIntent && this.video.paused && this.maybeResumePlayback(), this.fetchNextChunk(), this.evaluateCatchup();
    }
  }
  /** Schedule one source-size poll (single timer). */
  scheduleLivePoll() {
    this.livePollTimer !== null || !this.liveMode || (this.livePollTimer = setTimeout(() => {
      var e;
      this.livePollTimer = null, (e = this.worker) == null || e.postMessage({ type: "pollLive" });
    }, this.LIVE_POLL_MS));
  }
  /**
   * The current file has stopped growing (stalled at the edge). If the next file is already
   * bootstrapped, hand off to it seamlessly; otherwise emit 'live-end' once so the consumer can load
   * it (a brief gap until the standby is ready — see the v2 gapless mitigation in the plan).
   * Returns true if it activated the standby (the caller should stop further work this tick).
   */
  maybeCompleteLive() {
    return this.standbyReady && this.liveStallPolls >= 1 ? (this.beginGaplessSwitch(), !0) : (this.liveStallPolls < this.LIVE_STALL_MAX || this.liveEndEmitted || (this.liveEndEmitted = !0, this.emit("live-end", void 0)), !1);
  }
  /**
   * Live mode: report how far (seconds) the playhead is behind the true live edge. The consumer owns
   * the playlist (e.g. /api/live-files), so it is the only authority on lag once it exceeds the local
   * buffer cap — `bufferedAhead()` saturates at maxBufferSeconds. Used together with bufferedAhead to
   * drive catch-up (see evaluateCatchup). No-op outside live mode.
   */
  setLiveLag(e) {
    this.liveMode && (this.reportedLagSeconds = Math.max(0, e || 0), this.evaluateCatchup());
  }
  /**
   * Decide whether to catch up to the live edge, per liveCatchupStrategy. Called on the live cadence
   * (each liveUpdate/poll and each timeupdate). Lag = max(consumer-reported, local bufferedAhead):
   * the report covers large lag the local buffer can't see, bufferedAhead gives fine resolution for
   * the small-lag (speed) regime. Idempotent — state flags make the warnings fire only on transitions.
   */
  evaluateCatchup() {
    const e = this.config.liveCatchupStrategy;
    if (!this.liveMode || e === "off") {
      this.catchupActive && this.setCatchupSpeed(!1, 0);
      return;
    }
    if (this.switching || this.reanchorPending) return;
    const t = this.bufferedAhead(), i = Math.max(this.reportedLagSeconds, t);
    if (i < this.config.catchupJumpSeconds && (this.catchupJumpPending = !1), i >= this.config.catchupJumpSeconds) {
      this.catchupActive && this.setCatchupSpeed(!1, i), this.catchupJumpPending || (this.catchupJumpPending = !0, console.warn(`[live-catchup] jump → live edge (${i.toFixed(1)}s behind)`), this.emit("catchup-jump", { lagSeconds: i }));
      return;
    }
    e === "speed" && (this.catchupActive ? i <= this.config.catchupStopSeconds && this.setCatchupSpeed(!1, i) : i >= this.config.catchupStartSeconds && this.setCatchupSpeed(!0, i));
  }
  /** Engage/disengage the 'speed' catch-up: set the video element's rate AND tell the audio scheduler
   *  to follow it (so audio stays audible, pitched up, instead of muting as it does for J/L scrub). */
  setCatchupSpeed(e, t) {
    if (this.catchupActive === e) return;
    this.catchupActive = e;
    const i = e ? this.config.catchupRate : 1;
    this.audio.setCatchupRate(i), this.video.playbackRate = i, e ? console.warn(`[live-catchup] speed-up ×${i} (${t.toFixed(1)}s behind)`) : this.log("live-catchup: caught up — restored 1× speed"), this.emit("catchup", { active: e, rate: i, lagSeconds: t });
  }
  /**
   * Bootstrap the NEXT file in a standby worker so the switch is (near-)seamless. The standby opens
   * the file live-from-start (its beginning is contiguous with the current file's end) and continues
   * the continuous edit-unit counter; the exact base is locked at activation. Captures the standby's
   * manifest + init segment but does NOT append the init to MSE (same codec → the existing
   * SourceBuffer continues). Idempotent while a standby is already pending.
   */
  preloadNextUrl(e) {
    var s;
    if (!this.liveMode || this.standbyWorker) return;
    this.standbyReady = !1, this.standbyManifest = null, this.pendingNextUrl = e;
    const t = this.createWorker();
    this.standbyWorker = t, this.standbyListener = (r) => {
      const a = r.data;
      a.type === "manifest" ? this.standbyManifest = a : a.type === "initSegment" ? (this.standbyReady = !0, this.liveAtEdge && this.liveStallPolls >= 1 && this.beginGaplessSwitch()) : a.type === "error" && a.fatal && this.emit("error", { message: `standby preload: ${a.message}`, fatal: !1 });
    }, t.addEventListener("message", this.standbyListener);
    const i = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: p(this.config.plugins.videoDecoder) } : void 0;
    t.postMessage({
      type: "initUrl",
      url: e,
      debug: this.config.debug,
      videoMode: "mse",
      plugins: i,
      live: !0,
      startEditUnit: this.nextFetchFrame,
      liveFromStart: !0
    });
  }
  /**
   * Switch to the next live file. If it isn't already being preloaded, start preloading it now; the
   * actual hand-off happens as soon as the standby is ready and the current file is done. Call this
   * from the 'live-end' handler, or proactively when the next file appears in your playlist.
   */
  switchLive(e) {
    if (!this.liveMode) {
      this.loadLive(e);
      return;
    }
    this.standbyWorker || this.preloadNextUrl(e), this.standbyReady && this.beginGaplessSwitch();
  }
  /**
   * Begin the gapless hand-off to a ready standby. Before swapping, drain the OLD worker's held
   * reorder frames (flushLiveTail) so its video OUTPUT frontier catches up to its AUDIO frontier as far
   * as the file allows. The flushed tail video lands in MSE, then liveTailFlushed reports the seam base
   * = the earlier of the two track frontiers (so a mid-GOP cut where audio leads video can't leave a
   * video gap) and runs activateStandby(). Idempotent while a switch is in flight.
   */
  beginGaplessSwitch() {
    var e;
    this.switching || !this.standbyWorker || !this.standbyReady || !this.standbyManifest || (this.switching = !0, this.livePollTimer !== null && (clearTimeout(this.livePollTimer), this.livePollTimer = null), this.seqBase += 2, (e = this.worker) == null || e.postMessage({ type: "flushLiveTail", seqBase: this.seqBase }));
  }
  /**
   * Swap the standby worker in as the active one, continuing the timeline on the SAME MSE buffer +
   * audio context with no gap (no teardown → no black/refill). Called from the liveTailFlushed reply,
   * so `nextFetchFrame` is the seam base (the earlier of the old file's two track frontiers); the next
   * file's first frame of each track continues from there — the lagging track abuts, the leading one
   * overlaps a few units (replaced, not gapped).
   */
  activateStandby() {
    var s;
    const e = this.standbyWorker, t = this.standbyManifest;
    if (!e || !this.standbyReady || !t) {
      this.switching = !1;
      return;
    }
    this.livePollTimer !== null && (clearTimeout(this.livePollTimer), this.livePollTimer = null), e.postMessage({ type: "setStartEditUnit", startEditUnit: this.nextFetchFrame }), (s = this.worker) == null || s.terminate(), this.standbyListener && (e.removeEventListener("message", this.standbyListener), this.standbyListener = null), this.worker = e, this.standbyWorker = null, this.standbyReady = !1, this.standbyManifest = null, this.attachWorkerListeners(e), this.editRateNumerator = t.editRateNumerator, this.editRateDenominator = t.editRateDenominator, this.audio.setEditRate(t.editRateNumerator, t.editRateDenominator), this.liveAtEdge = !1, this.liveStallPolls = 0, this.liveEndEmitted = !1, this.fetchPending = !1, this.previewParked = !1, this.bufferFull = !1, this.switching = !1;
    const i = this.pendingNextUrl;
    this.pendingNextUrl = null, this.log(`live: gapless switch to next file at editUnit ${this.nextFetchFrame}`), i && this.emit("live-switched", { url: i }), this.fetchNextChunk(), this.scheduleLivePoll();
  }
  /**
   * Edge re-anchor: jump to the live edge of `url` (a newer chunk just produced by the recorder) with
   * a CLEAN reset (fresh MSE + audio), reusing a pre-parsed standby worker so there is NO header
   * re-parse. Combines the standby pre-bootstrap (instant) with a clean cut (no A/V seam) — the basis
   * for low-latency edge-seeking live playback. Falls back to loadLive() when not in live mode.
   */
  reanchorLive(e) {
    if (!this.liveMode) {
      this.loadLive(e);
      return;
    }
    if (this.standbyReady && this.standbyWorker) {
      this.reanchorToStandby();
      return;
    }
    this.reanchorPending = !0, this.standbyWorker || this.preloadEdge(e);
  }
  /** Pre-parse `url` in a background standby worker (header + transcoder + init segment built while
   *  the current file keeps playing), so the swap in reanchorToStandby() is near-instant.
   *  liveFromStart:false → EDGE-SCAN (findLiveStartByte) to start near the file's current END, snapped
   *  to a clean keyframe. This is the catch-up-to-edge path: it must land at the live edge regardless of
   *  how old the target file is (it can be a freshly-rotated 1-2 s chunk OR the mid-write newest file
   *  ~a whole rotation old when we've fallen far behind). Starting at the file's BEGINNING here (the old
   *  behaviour) left us a whole file-duration behind → an immediate re-jump loop. Same as loadLive's
   *  first-file behaviour. startEditUnit:0 → fresh timeline. */
  preloadEdge(e) {
    var s;
    if (this.standbyWorker) return;
    this.standbyReady = !1, this.standbyManifest = null, this.standbyInitSegment = null;
    const t = this.createWorker();
    this.standbyWorker = t, this.standbyListener = (r) => {
      const a = r.data;
      a.type === "manifest" ? this.standbyManifest = a : a.type === "initSegment" ? (this.standbyInitSegment = a.data, this.standbyReady = !0, this.reanchorPending && this.reanchorToStandby()) : a.type === "error" && a.fatal && this.emit("error", { message: `edge preload: ${a.message}`, fatal: !1 });
    }, t.addEventListener("message", this.standbyListener);
    const i = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: p(this.config.plugins.videoDecoder) } : void 0;
    t.postMessage({
      type: "initUrl",
      url: e,
      debug: this.config.debug,
      videoMode: "mse",
      plugins: i,
      live: !0,
      startEditUnit: 0,
      liveFromStart: !1
    });
  }
  /** Promote the pre-parsed standby worker with a clean MSE + audio reset (no gapless continuation,
   *  so no A/V seam). Reuses the standby's already-built transcoder + init segment — no header
   *  re-parse. Re-driving onManifest with the pre-parsed manifest re-opens MSE, recreates the audio
   *  context, flushes the (reused) init segment, and kicks the first edge fetch. */
  reanchorToStandby() {
    var s, r;
    const e = this.standbyWorker, t = this.standbyManifest, i = this.standbyInitSegment;
    !e || !this.standbyReady || !t || !i || (this.reanchorPending = !1, this.livePollTimer !== null && (clearTimeout(this.livePollTimer), this.livePollTimer = null), (s = this.worker) == null || s.terminate(), this.standbyListener && (e.removeEventListener("message", this.standbyListener), this.standbyListener = null), this.worker = e, this.standbyWorker = null, this.standbyReady = !1, this.standbyManifest = null, this.standbyInitSegment = null, this.attachWorkerListeners(e), (r = this.mseController) == null || r.destroy(), this.createMseController(), this.audio.destroy(), this.nextFetchFrame = 0, this.seqBase = 0, this.fetchPending = !1, this.bufferFull = !1, this.previewParked = !1, this.liveAtEdge = !1, this.liveStallPolls = 0, this.liveEndEmitted = !1, this.catchupActive = !1, this.catchupJumpPending = !1, this.reportedLagSeconds = 0, this.video.playbackRate = 1, this.playIntent = !0, this.pendingInitSegment = i, this.log("live: re-anchored to edge (reused header, clean reset)"), this.onManifest(t));
  }
  log(e) {
    this.config.debug && console.log("[mxf.js]", e);
  }
  /** Debug: the <video> element's buffered ranges as "[s1-e1][s2-e2]…" (a gap between ranges is the
   *  hang-then-skip symptom). */
  videoRanges() {
    const e = this.video.buffered;
    let t = "";
    for (let i = 0; i < e.length; i++) t += `[${e.start(i).toFixed(2)}-${e.end(i).toFixed(2)}]`;
    return t || "[]";
  }
  destroyInternal() {
    var e, t, i;
    (e = this.worker) == null || e.terminate(), this.worker = null, this.standbyListener && this.standbyWorker && this.standbyWorker.removeEventListener("message", this.standbyListener), (t = this.standbyWorker) == null || t.terminate(), this.standbyWorker = null, this.standbyListener = null, this.standbyReady = !1, this.standbyManifest = null, this.switching = !1, this.pendingNextUrl = null, this.livePollTimer !== null && (clearTimeout(this.livePollTimer), this.livePollTimer = null), this.liveMode = !1, this.liveAtEdge = !1, this.liveStallPolls = 0, this.liveEndEmitted = !1, this.catchupActive = !1, this.catchupJumpPending = !1, this.reportedLagSeconds = 0, this.video.playbackRate = 1, (i = this.mseController) == null || i.destroy(), this.mseController = null, this.audio.destroy(), this.manifest = null, this.nextFetchFrame = 0, this.fetchPending = !1, this.bufferFull = !1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.scrub.reset();
  }
  destroy() {
    this.destroyed = !0;
    const e = this.video;
    this.rvfcHandle && typeof e.cancelVideoFrameCallback == "function" && e.cancelVideoFrameCallback(this.rvfcHandle), this.rvfcHandle = 0, this.destroyInternal(), this.removeAllListeners(), this.emit("destroyed", void 0);
  }
}
export {
  V as MxfPlayer,
  O as decodeSmpte12mBcd,
  C as formatTimecode,
  M as frameCountToTimecode,
  G as timecodeToFrameCount
};
//# sourceMappingURL=mxf.esm.js.map
