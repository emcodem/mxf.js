class R {
  constructor() {
    this.listeners = /* @__PURE__ */ new Map();
  }
  on(e, i) {
    const t = String(e);
    return this.listeners.has(t) || this.listeners.set(t, /* @__PURE__ */ new Set()), this.listeners.get(t).add(i), this;
  }
  off(e, i) {
    var t;
    return (t = this.listeners.get(String(e))) == null || t.delete(i), this;
  }
  once(e, i) {
    const t = (s) => {
      i(s), this.off(e, t);
    };
    return this.on(e, t);
  }
  emit(e, i) {
    var t;
    (t = this.listeners.get(String(e))) == null || t.forEach((s) => {
      try {
        s(i);
      } catch {
      }
    });
  }
  removeAllListeners() {
    this.listeners.clear();
  }
}
const y = 1, E = 0.5, A = 3, D = 6, N = y + 0.5;
class v extends R {
  constructor(e, i = !1) {
    super(), this.mediaSource = null, this.objectURL = null, this.sourceBuffers = /* @__PURE__ */ new Map(), this.queues = /* @__PURE__ */ new Map(), this.processing = /* @__PURE__ */ new Map(), this.video = e, this.debug = i;
  }
  open(e, i) {
    return new Promise((t, s) => {
      this.mediaSource = new MediaSource(), this.objectURL = URL.createObjectURL(this.mediaSource), this.video.src = this.objectURL, this.mediaSource.addEventListener("sourceopen", () => {
        try {
          e && MediaSource.isTypeSupported(e) && this.addSourceBuffer("video", e), i && MediaSource.isTypeSupported(i) && this.addSourceBuffer("audio", i), t();
        } catch (r) {
          s(r);
        }
      }, { once: !0 }), this.mediaSource.addEventListener("error", () => s(new Error("MediaSource error")), { once: !0 });
    });
  }
  addSourceBuffer(e, i) {
    this.debug && console.log(`[mse] addSourceBuffer ${e} "${i}"`);
    const t = this.mediaSource.addSourceBuffer(i);
    this.sourceBuffers.set(e, t), this.queues.set(e, []), this.processing.set(e, !1), t.addEventListener("updateend", () => {
      this.processing.set(e, !1), this.emit("appended", { track: e }), this.drainQueue(e);
    }), t.addEventListener("error", () => {
      const s = `SourceBuffer error on ${e} track — codec may be unsupported or data is malformed`;
      console.error(`[mxf.js] ${s}`), this.emit("error", { track: e, message: s });
    });
  }
  appendSegment(e, i) {
    const t = this.queues.get(e);
    t && (t.push({ kind: "append", data: i }), this.drainQueue(e));
  }
  /** Queue a removal of buffered media in [start, end) for a track (used to cap buffer growth). */
  evict(e, i, t) {
    const s = this.queues.get(e);
    !s || t <= i || (s.push({ kind: "remove", start: i, end: t }), this.drainQueue(e));
  }
  /**
   * Evict already-played media older than `BACK_BUFFER_SECONDS` behind `currentTime` on every track,
   * keeping the resident buffer bounded. Called as playback advances. No-op if there's nothing old
   * enough to remove.
   */
  trimBackBuffer(e) {
    const i = e - D;
    if (!(i <= 0))
      for (const [t, s] of this.sourceBuffers) {
        if (s.buffered.length === 0) continue;
        const r = s.buffered.start(0);
        i > r + 0.5 && this.evict(t, r, i);
      }
  }
  /**
   * Evict buffered ranges that start more than `keepAheadSeconds` beyond `currentTime` on every
   * track. Heavy seeking (repeated ±N s skips, scrub previews) scatters small orphan ranges far
   * ahead of the playhead that back-buffer trimming never reaches (it only removes behind). Forward
   * fetching never fills past the buffer-ahead target, so any range starting well beyond it is an
   * abandoned-seek leftover — safe to drop, keeping the resident buffer bounded during heavy seeking.
   */
  trimForwardOrphans(e, i) {
    const t = e + i;
    for (const [s, r] of this.sourceBuffers)
      for (let a = r.buffered.length - 1; a >= 0; a--) {
        const n = r.buffered.start(a);
        n > t && this.evict(s, n, r.buffered.end(a));
      }
  }
  drainQueue(e) {
    if (this.processing.get(e)) return;
    const i = this.queues.get(e), t = this.sourceBuffers.get(e);
    if (!i || !t || i.length === 0 || t.updating) return;
    const s = i[0];
    this.processing.set(e, !0);
    try {
      if (s.kind === "append")
        i.shift(), t.appendBuffer(s.data);
      else {
        i.shift();
        const r = t.buffered.length ? t.buffered.start(0) : s.start, a = t.buffered.length ? t.buffered.end(t.buffered.length - 1) : s.end, n = Math.max(s.start, r), d = Math.min(s.end, a);
        d > n ? t.remove(n, d) : (this.processing.set(e, !1), this.drainQueue(e));
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
  handleQuota(e, i) {
    const t = this.sourceBuffers.get(e), s = this.queues.get(e);
    if (!t || !s) return;
    s.unshift({ kind: "append", data: i });
    const a = this.video.currentTime - 2, n = t.buffered.length ? t.buffered.start(0) : 0;
    t.buffered.length > 0 && a > n + 0.5 ? (s.unshift({ kind: "remove", start: n, end: a }), this.drainQueue(e)) : (this.debug && console.warn(`[mse] ${e} buffer full — pausing fetch until playhead advances`), this.emit("bufferfull", void 0));
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
        if ([...this.sourceBuffers.values()].some((t) => t.updating))
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
    const i = this.sourceBuffers.get(e);
    return !i || i.buffered.length === 0 ? 0 : i.buffered.end(i.buffered.length - 1);
  }
  /**
   * Seconds of media buffered contiguously starting at `time`. Unlike getBufferedEnd this is
   * range-aware: if `time` is not inside any buffered range it returns 0 (data is needed here
   * now), and if it is, it returns the end of *that* range — not the end of some unrelated
   * later range. This is what fetch scheduling must use, otherwise a seek into an unbuffered
   * gap while a far-ahead range exists looks "buffered" and never fetches → permanent stall.
   */
  getBufferedAhead(e, i) {
    const t = this.sourceBuffers.get(e);
    if (!t || t.buffered.length === 0) return 0;
    for (let s = 0; s < t.buffered.length; s++) {
      const r = t.buffered.start(s), a = t.buffered.end(s);
      if (i >= r - 0.25 && i < a) return a - i;
    }
    return 0;
  }
  /** Returns the current buffered start time in seconds for a given track */
  getBufferedStart(e) {
    const i = this.sourceBuffers.get(e);
    return !i || i.buffered.length === 0 ? 0 : i.buffered.start(0);
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
  static getMimeType(e, i) {
    if (e === "video") {
      if (i === "h264" || i.startsWith("avc1."))
        return `video/mp4; codecs="${i.startsWith("avc1.") ? i : "avc1.640033"}"`;
      if (i === "mpeg2") return 'video/mp4; codecs="mp4v.20.2"';
    }
    if (e === "audio") {
      if (i === "aac") return 'audio/mp4; codecs="mp4a.40.2"';
      if (i === "pcm")
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
const P = 40, I = 0.25, $ = 0.08, U = 2, W = 30, l = class l {
  // edit units already received (duplicate probe)
  constructor(e, i, t = !1) {
    this.video = e, this.onAudioInfo = i, this.diag = t, this.cxt = null, this.timer = null, this.gainNode = null, this.volume = 1, this.anchored = !1, this.anchorCtx = 0, this.anchorMedia = 0, this.runId = 0, this.lastWall = -1, this.lastMedia = 0, this.store = [], this.channelCount = 0, this.active = [0, 1], this.editRateNumerator = 25, this.editRateDenominator = 1, this.diagBuf = [], this.diagHead = 0, this.diagSeq = 0, this.diagWarnAt = {}, this.schedCtxEnd = -1, this.arriveDur = -1, this.arriveCh = 0, this.arriveRate = 0, this.seenEU = /* @__PURE__ */ new Set();
  }
  setEditRate(e, i) {
    this.editRateNumerator = e, this.editRateDenominator = i;
  }
  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(e) {
    this.cxt = new AudioContext({ sampleRate: e }), this.gainNode = this.cxt.createGain(), this.gainNode.gain.value = this.volume, this.gainNode.connect(this.cxt.destination), this.timer || (this.timer = setInterval(() => this.tick(), P));
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
    const i = 0.5 * this.editRateDenominator / this.editRateNumerator;
    let t = -1;
    for (const s of this.store)
      if (t < 0)
        s.mediaStart <= e + 1e-6 && s.mediaEnd > e && (t = s.mediaEnd);
      else if (s.mediaStart - t <= i)
        t = s.mediaEnd;
      else
        break;
    return t < 0 ? 0 : Math.max(0, t - e);
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
    this.active = [...new Set(e.filter((t) => Number.isInteger(t) && t >= 0))].sort((t, s) => t - s), this.stopSources(), this.runId++;
    const i = this.video;
    this.anchored && this.cxt && !i.paused && !i.seeking && Math.abs(i.playbackRate - 1) <= 0.01 && this.pump(i.currentTime);
  }
  /**
   * Record a (descriptor- or stream-derived) channel count, clamp the active selection to it, and
   * announce it. Used both at manifest time (before audio plays, so the UI can build a selector) and
   * when a decoded chunk's count differs from what we last announced.
   */
  applyChannelCount(e) {
    e <= 0 || e === this.channelCount || (this.channelCount = e, this.active = this.active.filter((i) => i < e), this.active.length === 0 && (this.active = e >= 2 ? [0, 1] : [0]), this.onAudioInfo({ channelCount: e, activeChannels: this.active.slice() }));
  }
  /**
   * Store a decoded interleaved PCM chunk addressed by its media time (editUnit → seconds). It is NOT
   * played here — the look-ahead scheduler emits it when the <video> playhead reaches it, so audio
   * stays locked to the picture regardless of when this chunk happened to arrive.
   */
  schedule(e, i, t, s) {
    if (!this.cxt) return;
    this.applyChannelCount(t);
    const r = Math.floor(e.length / t);
    if (r <= 0) return;
    const a = s * this.editRateDenominator / this.editRateNumerator, n = r / i, d = {
      mediaStart: a,
      mediaEnd: a + n,
      duration: n,
      samples: e,
      channelCount: t,
      sampleRate: i,
      source: null,
      lastRun: -1,
      scheduledOnce: !1
    };
    this.diag && (this.rec("arrive", !1, a, { eu: s, dur: +n.toFixed(5), ch: t, rate: i }), this.seenEU.has(s) ? this.rec("dup-eu", !0, a, { eu: s }) : this.seenEU.add(s), this.arriveRate && (t !== this.arriveCh || i !== this.arriveRate) && this.rec("param-change", !0, a, { ch: t, wasCh: this.arriveCh, rate: i, wasRate: this.arriveRate }), this.arriveDur > 0 && Math.abs(n - this.arriveDur) > this.arriveDur * 0.05 && this.rec("dur-jump", !0, a, { dur: +n.toFixed(5), was: +this.arriveDur.toFixed(5), samples: r }), this.arriveDur = n, this.arriveCh = t, this.arriveRate = i), this.insertChunk(d);
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
    const i = 0.5 * this.editRateDenominator / this.editRateNumerator;
    if (this.isRegionResident(e.mediaStart, e.mediaEnd, i)) {
      this.diag && this.rec("refetch-skip", !1, e.mediaStart, { end: +e.mediaEnd.toFixed(3) });
      return;
    }
    for (let r = this.store.length - 1; r >= 0; r--) {
      const a = this.store[r];
      if (a.mediaEnd - e.mediaStart > i && e.mediaEnd - a.mediaStart > i) {
        if (a.source)
          try {
            a.source.onended = null, a.source.stop();
          } catch {
          }
        this.store.splice(r, 1);
      }
    }
    let t = 0, s = this.store.length;
    for (; t < s; ) {
      const r = t + s >> 1;
      this.store[r].mediaStart < e.mediaStart ? t = r + 1 : s = r;
    }
    if (this.store.splice(t, 0, e), this.diag && t > 0) {
      const r = e.mediaStart - this.store[t - 1].mediaEnd;
      r > i && r < 1 && this.rec("coverage-gap", !0, e.mediaStart, { gap: +r.toFixed(4) });
    }
  }
  /** Debug: audio store summary "N:[s0-e0][s1-e1]…" (chunk count + each chunk's media span), so a gap
   *  or a short/diverged store is visible in the gate log. */
  debugStore() {
    if (!this.store.length) return "0:[]";
    let e = `${this.store.length}:`;
    for (const i of this.store) e += `[${i.mediaStart.toFixed(2)}-${i.mediaEnd.toFixed(2)}]`;
    return e;
  }
  /** True when [start, end) is already contiguously covered by chunks in the store, i.e. a fetch for
   *  this span would be redundant. `store` is sorted by mediaStart; walk from the chunk covering
   *  `start` and extend while tiles are contiguous (gap ≤ eps), succeeding as soon as reach ≥ end. */
  isRegionResident(e, i, t) {
    let s = -1;
    for (const r of this.store) {
      if (s < 0)
        r.mediaStart <= e + t && r.mediaEnd > e && (s = r.mediaEnd);
      else if (r.mediaStart - s <= t)
        s = Math.max(s, r.mediaEnd);
      else
        break;
      if (s >= i - t) return !0;
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
    const i = this.video, t = i.currentTime;
    if (this.evict(t), i.paused || i.seeking || Math.abs(i.playbackRate - 1) > 0.01) {
      this.anchored && this.unlock("gate"), this.lastWall = -1;
      return;
    }
    const s = e.currentTime;
    if (this.lastWall >= 0) {
      const r = s - this.lastWall, a = t - this.lastMedia;
      if (r > 5e-3 && a < 0.25 * r) {
        this.rec("stall", !0, t, { wallDelta: +r.toFixed(3), mediaDelta: +a.toFixed(3) }), this.anchored && this.unlock("stall"), this.lastWall = s, this.lastMedia = t;
        return;
      }
    }
    if (this.lastWall = s, this.lastMedia = t, !this.anchored)
      this.lockTo(t);
    else {
      const r = s - this.anchorCtx + this.anchorMedia;
      Math.abs(r - t) > $ && this.lockTo(t);
    }
    this.diag && (this.store.some((a) => a.mediaStart <= t + 1e-6 && a.mediaEnd > t) || this.rec("underrun", !0, t, { chunks: this.store.length })), this.pump(t);
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
    const i = this.cxt, t = e + I, s = i.currentTime;
    for (const r of this.store) {
      if (r.mediaStart >= t) break;
      if (r.lastRun === this.runId) continue;
      if (r.lastRun = this.runId, r.mediaEnd <= e - 0.02) {
        this.diag && !r.scheduledOnce && e - r.mediaEnd < 0.5 && this.rec("drop", !0, r.mediaStart, { reason: "behind-unplayed", mediaEnd: +r.mediaEnd.toFixed(3) });
        continue;
      }
      const a = this.anchorCtx + (r.mediaStart - this.anchorMedia), n = s - a;
      if (n >= r.duration - 2e-3) {
        this.diag && !r.scheduledOnce && n - r.duration < 0.5 && this.rec("drop", !0, r.mediaStart, { reason: "missed", into: +n.toFixed(4), dur: +r.duration.toFixed(4) });
        continue;
      }
      const d = this.makeSource(r);
      if (d && (n <= 0 ? d.start(a) : d.start(s, n), r.source = d, r.scheduledOnce = !0, d.onended = () => {
        r.source = null;
      }, this.diag)) {
        const h = n <= 0 ? a + r.duration : s + (r.duration - n), c = this.schedCtxEnd >= 0 ? a - this.schedCtxEnd : 0;
        this.rec(
          "sched",
          this.schedCtxEnd >= 0 && Math.abs(c) > 1e-3,
          r.mediaStart,
          { mode: n <= 0 ? "future" : "straddle", gap: +c.toFixed(5), ctxStart: +a.toFixed(4), ctxEnd: +h.toFixed(4) }
        ), this.schedCtxEnd = h;
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
    const i = this.cxt, { samples: t, channelCount: s, sampleRate: r } = e, a = Math.floor(t.length / s), n = this.active.filter((u) => u < s);
    if (n.length === 0) return null;
    const d = [], h = [];
    n.forEach((u, g) => (g % 2 === 0 ? d : h).push(u)), n.length === 1 && (h.length = 0, h.push(n[0]));
    const c = i.createBuffer(2, a, r), m = (u, g) => {
      if (g.length !== 0)
        for (let p = 0; p < a; p++) {
          let x = 0;
          const w = p * s;
          for (const B of g) x += t[w + B];
          u[p] = x;
        }
    };
    m(c.getChannelData(0), d), m(c.getChannelData(1), h);
    const f = i.createBufferSource();
    return f.buffer = c, f.connect(this.gainNode ?? i.destination), f;
  }
  /** Drop chunks well behind or far ahead of the playhead to bound memory. */
  evict(e) {
    if (this.store.length === 0) return;
    const i = [];
    for (const t of this.store) {
      if (t.mediaEnd < e - U || t.mediaStart > e + W) {
        if (t.source)
          try {
            t.source.onended = null, t.source.stop();
          } catch {
          }
        continue;
      }
      i.push(t);
    }
    this.store = i;
  }
  // ── Diagnostics helpers ──────────────────────────────────────────────────────────────────────
  /** Record a diagnostic event into the ring (no-op unless diag is on). Anomalies also console.warn,
   *  rate-limited per type so one stutter can't produce a wall of logs. */
  rec(e, i, t, s) {
    if (!this.diag) return;
    const r = this.cxt ? this.cxt.currentTime : 0;
    if (this.diagBuf[this.diagHead] = { seq: this.diagSeq++, t: r, media: t, type: e, anomaly: i, detail: s }, this.diagHead = (this.diagHead + 1) % l.DIAG_CAP, i) {
      const a = this.diagWarnAt[e] ?? -1 / 0;
      r - a >= 0.2 && (this.diagWarnAt[e] = r, console.warn(`[audio-diag] ${e} media=${t.toFixed(3)}s t=${r.toFixed(3)}s`, s));
    }
  }
  /**
   * Dump the recent scheduling history to the console — call the instant a glitch is heard. The ring
   * holds the preceding ~DIAG_WINDOW seconds, so the dump shows what happened just BEFORE the keypress
   * (where the glitch was). Includes a state snapshot and a boundary-sample probe: a large jump at a
   * tile join with no scheduling anomaly means the click is in the decoded data/mix, not the scheduler.
   */
  dumpDiag(e = "") {
    var d;
    if (!this.diag) {
      console.warn("[audio-diag] diagnostics are off (construct WebAudioController with diag=true)");
      return;
    }
    const i = this.cxt ? this.cxt.currentTime : 0, t = this.video, s = t.currentTime, r = this.diagBuf.filter((h) => !!h && i - h.t <= l.DIAG_WINDOW).sort((h, c) => h.seq - c.seq), a = this.store.length ? { from: +this.store[0].mediaStart.toFixed(3), to: +this.store[this.store.length - 1].mediaEnd.toFixed(3), chunks: this.store.length } : { from: 0, to: 0, chunks: 0 };
    console.group(`[audio-diag] mark ${e} @ media=${s.toFixed(3)}s t=${i.toFixed(3)}s (${r.length} events / ${l.DIAG_WINDOW}s)`), console.log("state", {
      anchored: this.anchored,
      runId: this.runId,
      cxtState: (d = this.cxt) == null ? void 0 : d.state,
      paused: t.paused,
      seeking: t.seeking,
      rate: t.playbackRate,
      active: this.active.slice(),
      coverage: a
    }), console.table(r.map((h) => ({ dt: +(h.t - i).toFixed(3), type: h.type, media: +h.media.toFixed(3), anomaly: h.anomaly, ...h.detail })));
    const n = this.boundaryProbe(s);
    n.length && (console.log("tile-join discontinuities (mixed output; large jump = click in data/mix):"), console.table(n)), console.groupEnd();
  }
  /** Mixed-output discontinuity at each contiguous tile join near the playhead. A large jump = a click
   *  baked into the decoded PCM or the channel mix, not a scheduling fault. */
  boundaryProbe(e) {
    const i = 0.5 * this.editRateDenominator / this.editRateNumerator, t = [];
    for (let s = 0; s + 1 < this.store.length; s++) {
      const r = this.store[s], a = this.store[s + 1];
      if (r.mediaEnd < e - 1 || a.mediaStart > e + 1 || Math.abs(a.mediaStart - r.mediaEnd) > i) continue;
      const n = this.mixFrame(r, Math.floor(r.samples.length / r.channelCount) - 1), d = this.mixFrame(a, 0);
      t.push({ join: +r.mediaEnd.toFixed(3), jumpL: +Math.abs(n[0] - d[0]).toFixed(4), jumpR: +Math.abs(n[1] - d[1]).toFixed(4) });
    }
    return t;
  }
  /** The stereo [L,R] sample the active-channel mix produces for frame `i` of a chunk (mirrors makeSource). */
  mixFrame(e, i) {
    const t = this.active.filter((d) => d < e.channelCount);
    if (t.length === 0 || i < 0) return [0, 0];
    const s = [], r = [];
    t.forEach((d, h) => (h % 2 === 0 ? s : r).push(d)), t.length === 1 && (r.length = 0, r.push(t[0]));
    const a = i * e.channelCount, n = (d) => d.reduce((h, c) => h + e.samples[a + c], 0);
    return [n(s), n(r)];
  }
  /** Tear down the AudioContext and reset all state for the next file. */
  destroy() {
    var e;
    this.stopSources(), this.store = [], this.timer && (clearInterval(this.timer), this.timer = null), (e = this.cxt) == null || e.close().catch(() => {
    }), this.cxt = null, this.gainNode = null, this.anchored = !1, this.channelCount = 0, this.diagBuf = [], this.diagHead = 0, this.diagSeq = 0, this.diagWarnAt = {}, this.schedCtxEnd = -1, this.arriveDur = -1, this.arriveCh = 0, this.arriveRate = 0, this.seenEU.clear();
  }
};
l.DIAG_CAP = 512, l.DIAG_WINDOW = 3;
let k = l;
class q {
  constructor(e, i, t, s) {
    this.video = e, this.requestPreview = i, this.settle = t, this.resume = s, this.active = !1, this.cycle = 0, this.latestFrame = null, this.seq = 0, this.watchdog = null, this.wasPlaying = !1, this.suppressSeeking = !1, this.hasStream = !1, this.duration = 0, this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  /** True while a scrub is in progress (beginScrub→endScrub). */
  get isActive() {
    return this.active;
  }
  /** Record stream parameters once the manifest arrives (enables scrubTo/endScrub). */
  setStream(e, i, t) {
    this.hasStream = !0, this.duration = e, this.editRateNumerator = i, this.editRateDenominator = t;
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
    const i = Math.max(0, Math.min(e, this.duration));
    this.latestFrame = Math.round(i * this.editRateNumerator / this.editRateDenominator), this.pump();
  }
  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position). Moves
   * the playhead there, suppresses the resulting self-induced 'seeking', drives the accurate settle,
   * and resumes playback if it was running. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(e) {
    if (!this.active || (this.active = !1, this.latestFrame = null, this.cycle = 0, this.clearWatchdog(), !this.hasStream)) return;
    const i = Math.max(0, Math.min(e ?? this.video.currentTime, this.duration));
    this.suppressSeeking = i !== this.video.currentTime, this.video.currentTime = i, this.settle(i), this.wasPlaying && this.resume();
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
    const i = Math.max(0, Math.min(e * this.editRateDenominator / this.editRateNumerator, this.duration));
    if (Math.abs(i - this.video.currentTime) < 1e-3) {
      this.completeRender();
      return;
    }
    this.cycle = 2, this.suppressSeeking = !0, this.video.currentTime = i, this.clearWatchdog(), this.watchdog = setTimeout(() => this.completeRender(), 400);
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
function S(o) {
  return (o < 10 ? "0" : "") + o;
}
function b(o, e) {
  return e && (o === 30 || o === 60);
}
function T(o) {
  return o === 60 ? 4 : 2;
}
function V(o) {
  const e = o.base;
  if (e <= 0) return 0;
  let i = ((o.hours * 60 + o.minutes) * 60 + o.seconds) * e + o.frames;
  if (b(e, o.dropFrame)) {
    const t = T(e), s = o.hours * 60 + o.minutes;
    i -= t * (s - Math.floor(s / 10));
  }
  return i;
}
function C(o, e, i) {
  if (e <= 0) return { hours: 0, minutes: 0, seconds: 0, frames: 0, dropFrame: !1, base: e };
  let t = o < 0 ? 0 : Math.floor(o);
  const s = b(e, i);
  if (s) {
    const h = T(e), c = e * 600 - h * 9, m = e * 60 - h, f = Math.floor(t / c), u = t % c;
    t += h * 9 * f + (u > h ? h * Math.floor((u - h) / m) : 0);
  }
  const r = t % e, a = Math.floor(t / e) % 60, n = Math.floor(t / (e * 60)) % 60;
  return { hours: Math.floor(t / (e * 3600)) % 24, minutes: n, seconds: a, frames: r, dropFrame: s, base: e };
}
function F(o) {
  const e = b(o.base, o.dropFrame) ? ";" : ":";
  return `${S(o.hours)}:${S(o.minutes)}:${S(o.seconds)}${e}${S(o.frames)}`;
}
function G(o, e = 0) {
  if (o.length < 4) return null;
  const i = (o[0] & 15) + (o[0] >> 4 & 3) * 10, t = (o[0] & 64) !== 0, s = (o[1] & 15) + (o[1] >> 4 & 7) * 10, r = (o[2] & 15) + (o[2] >> 4 & 7) * 10;
  return { hours: (o[3] & 15) + (o[3] >> 4 & 3) * 10, minutes: r, seconds: s, frames: i, dropFrame: t, base: e };
}
const L = {
  mpeg2video: "mpeg2",
  h264: "h264",
  libx264: "h264"
};
function M(o) {
  const e = o.mxfCodec ?? L[o.ffmpegCodec] ?? o.ffmpegCodec;
  return { moduleUrl: o.moduleUrl, ffmpegCodec: o.ffmpegCodec, mxfCodec: e };
}
const O = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: "auto",
  seekMode: "accurate",
  resumeBufferSeconds: N,
  debug: !1,
  plugins: {}
};
class _ extends R {
  constructor(e, i = {}) {
    super(), this.worker = null, this.mseController = null, this.manifest = null, this.nextFetchFrame = 0, this.framesPerChunk = 50, this.rampChunkFrames = 50, this.fetchPending = !1, this.bufferFull = !1, this.editRateNumerator = 25, this.editRateDenominator = 1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.rvfcHandle = 0, this.destroyed = !1, this.video = e, this.config = { ...O, ...i }, this.audio = new k(this.video, (t) => this.emit("audio-info", t), !!this.config.debug), this.scrub = new q(
      this.video,
      (t, s) => {
        var r;
        return (r = this.worker) == null ? void 0 : r.postMessage({ type: "scrubPreview", targetFrame: t, seq: s });
      },
      (t) => this.initiateSeek(t, "accurate"),
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
    const i = (t, s) => {
      this.destroyed || (this.updateTimecode(s.mediaTime), this.rvfcHandle = e.requestVideoFrameCallback(i));
    };
    this.rvfcHandle = e.requestVideoFrameCallback(i);
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
    const i = this.editRateNumerator / this.editRateDenominator;
    if (!(i > 0)) return;
    const t = Math.max(0, Math.floor(e * i + 1e-6));
    if (t === this.lastTimecodeEditUnit) return;
    this.lastTimecodeEditUnit = t;
    const s = this.computeTimecodeBundle(t);
    this.currentTimecodeBundle = s, this.emit("timecode", s);
  }
  /** System Item timecode at a presentation edit unit: nearest preceding anchor + linear offset. */
  systemTimecodeAt(e) {
    let i = null;
    for (const s of this.systemAnchors)
      s.editUnit <= e && (!i || s.editUnit > i.editUnit) && (i = s);
    if (!i) return null;
    const t = i.frameCount + (e - i.editUnit);
    return F(C(t, i.base, i.dropFrame));
  }
  /** Build the full timecode bundle (system + computed package TCs) for a rendered edit unit. */
  computeTimecodeBundle(e) {
    var d;
    const i = [], t = this.systemTimecodeAt(e);
    t !== null && i.push({ source: "system", text: t, reliable: !0 });
    const s = ((d = this.manifest) == null ? void 0 : d.indexMode) !== "none", r = this.editRateNumerator / this.editRateDenominator;
    for (const h of this.manifestTimecodes) {
      const c = h.editRateDenominator > 0 ? h.editRateNumerator / h.editRateDenominator : r, m = r > 0 ? Math.round(e * (c / r)) : e, f = F(C(h.position + m, h.base, h.dropFrame));
      i.push({ source: h.source, text: f, reliable: s });
    }
    const a = { system: 0, material: 1, source: 2, file: 3 };
    i.sort((h, c) => a[h.source] - a[c.source]);
    const n = i.length ? { source: i[0].source, text: i[0].text } : null;
    return { editUnit: e, primary: n, all: i };
  }
  /** The most recently computed timecode bundle for the frame on screen (null before playback). */
  get currentTimecode() {
    return this.currentTimecodeBundle;
  }
  /** Merge fresh System Item anchors, keeping the list sorted/deduped by edit unit and bounded. */
  mergeSystemAnchors(e) {
    for (const t of e) {
      const s = this.systemAnchors.findIndex((r) => r.editUnit === t.editUnit);
      s >= 0 ? this.systemAnchors[s] = t : this.systemAnchors.push(t);
    }
    this.systemAnchors.sort((t, s) => t.editUnit - s.editUnit);
    const i = 4096;
    this.systemAnchors.length > i && this.systemAnchors.splice(0, this.systemAnchors.length - i);
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
  /** Seek to a time in seconds. The <video> 'seeking' event drives the worker fetch. */
  seek(e) {
    if (!this.manifest) return;
    const i = Math.max(0, Math.min(e, this.manifest.duration));
    this.video.currentTime = i;
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
  loadUrl(e) {
    var s;
    this.setup();
    const i = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: M(this.config.plugins.videoDecoder) } : void 0, t = { type: "initUrl", url: e, debug: this.config.debug, videoMode: "mse", plugins: i };
    this.worker.postMessage(t);
  }
  loadFile(e) {
    var s;
    this.setup();
    const i = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: M(this.config.plugins.videoDecoder) } : void 0, t = { type: "initFile", file: e, debug: this.config.debug, videoMode: "mse", plugins: i };
    this.worker.postMessage(t);
  }
  setup() {
    this.destroyInternal(), this.worker = this.createWorker(), this.worker.addEventListener("message", (e) => this.onWorkerMessage(e.data)), this.worker.addEventListener("error", (e) => {
      var t;
      const i = [
        e.message,
        e.filename && `${e.filename}:${e.lineno ?? "?"}:${e.colno ?? "?"}`,
        (t = e.error) == null ? void 0 : t.stack
      ].filter(Boolean).join(" — ");
      console.error("[mxf.js] worker error:", e, e.error), this.emit("error", {
        message: i || "Worker failed to load — reload the page (the dev server may have restarted)",
        fatal: !0
      });
    }), this.worker.addEventListener("messageerror", (e) => {
      this.emit("error", { message: `Worker message error: ${String(e)}`, fatal: !0 });
    }), this.mseController = new v(this.video, !!this.config.debug), this.mseController.on("error", ({ track: e, message: i }) => {
      this.emit("error", { message: `MSE ${e}: ${i}`, fatal: !1 });
    }), this.mseController.on("bufferfull", () => {
      this.bufferFull = !0, this.fetchPending = !1;
    }), this.mseController.on("appended", ({ track: e }) => {
      e === "video" && this.playIntent && this.video.paused && this.maybeResumePlayback();
    });
  }
  createWorker() {
    const e = new URL("./demux-worker.js", import.meta.url);
    return new Worker(e, { type: "module" });
  }
  async onWorkerMessage(e) {
    var i, t, s, r, a;
    switch (e.type) {
      case "manifest":
        await this.onManifest(e);
        break;
      case "initSegment":
        (i = this.mseController) != null && i.hasVideoBuffer() || (t = this.mseController) != null && t.hasAudioBuffer() ? (this.mseController.appendSegment("video", e.data), this.mseController.appendSegment("audio", e.data), this.fetchNextChunk()) : this.pendingInitSegment = e.data;
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
          const h = Math.max(e.gopFrameCount, this.seekTargetFrame - n + 1, 1);
          this.fetchKeyframePreview(n, h);
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
      case "codecUnsupported":
        this.emit("codec-unsupported", { codec: e.codec, reason: e.reason });
        break;
      case "error":
        this.emit("error", { message: e.message, fatal: e.fatal });
        break;
    }
  }
  async onManifest(e) {
    var d, h;
    const i = e.pictureDescriptor, t = e.soundDescriptor;
    this.editRateNumerator = e.editRateNumerator, this.editRateDenominator = e.editRateDenominator, this.audio.setEditRate(e.editRateNumerator, e.editRateDenominator), this.scrub.setStream(e.duration, e.editRateNumerator, e.editRateDenominator);
    const s = e.editRateNumerator / e.editRateDenominator;
    this.framesPerChunk = Math.ceil(s * y), this.rampChunkFrames = Math.max(A, Math.ceil(s * E)), this.startupGating = !0, this.manifestTimecodes = e.timecodes ?? [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.manifest = {
      duration: e.duration,
      editRateNumerator: e.editRateNumerator,
      editRateDenominator: e.editRateDenominator,
      tracks: e.tracks,
      pictureDescriptor: i,
      soundDescriptor: t,
      displayWidth: e.displayWidth,
      displayHeight: e.displayHeight,
      aspectRatio: e.aspectRatio,
      indexMode: e.indexMode,
      longGop: e.longGop,
      timecodes: e.timecodes ?? []
    };
    const r = e.resolvedVideoCodec ?? (i == null ? void 0 : i.codec) ?? "unknown", a = i && e.videoCodecSupported ? v.getMimeType("video", r) : null;
    let n = t ? v.getMimeType("audio", t.codec) : null;
    (t == null ? void 0 : t.codec) === "pcm" && (this.config.pcmAudioMode === "webaudio" || !n) && (n = null, this.audio.createContext(t.sampleRate)), this.audio.applyChannelCount(e.audioChannelCount);
    try {
      await this.mseController.open(a, n);
    } catch (c) {
      this.emit("error", { message: `MSE open failed: ${c}`, fatal: !0 });
      return;
    }
    this.mseController.setDuration(e.duration), this.pendingInitSegment ? ((d = this.mseController) == null || d.appendSegment("video", this.pendingInitSegment), (h = this.mseController) == null || h.appendSegment("audio", this.pendingInitSegment), this.pendingInitSegment = null, this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${i == null ? void 0 : i.codec}, audio=${t == null ? void 0 : t.codec}`), this.fetchNextChunk()) : (this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${i == null ? void 0 : i.codec}, audio=${t == null ? void 0 : t.codec}`));
  }
  /**
   * Fetch a single I-frame at `keyframe` for a fast scrub preview, telling the worker to stretch
   * that one decoded sample across `stretchFrames` frame periods so it covers its whole GOP on the
   * MSE timeline. Posted directly (not via fetchNextChunk) so it isn't gated by the scrub guard.
   */
  fetchKeyframePreview(e, i) {
    if (!this.manifest) return;
    this.previewParked = !0, this.nextFetchFrame = e;
    const t = {
      type: "fetchSegment",
      startFrame: e,
      frameCount: 1,
      seqBase: this.seqBase,
      stretchToFrames: i
    };
    this.seqBase += 2, this.worker.postMessage(t);
  }
  fetchNextChunk(e) {
    var d;
    if (this.scrub.isActive || this.previewParked || this.bufferFull || this.fetchPending || !this.manifest) return;
    const i = this.video.currentTime, t = this.editRateNumerator / this.editRateDenominator;
    if (this.nextFetchFrame / t - i >= this.config.maxBufferSeconds) return;
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
    if (!this.manifest || this.scrub.consumeSuppressedSeeking()) return;
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
    const i = this.mseController.getBufferedAhead("video", e);
    if (i <= 0) return !1;
    const t = this.audio.bufferedAhead(e);
    if (t <= 0) return !1;
    const s = this.editRateNumerator / this.editRateDenominator, r = Math.min(this.nextFetchFrame / s, this.manifest.duration) - 0.5;
    return e + i >= r && e + t >= r;
  }
  onVideoSeeked() {
    this.scrub.onVideoSeeked();
  }
  initiateSeek(e, i) {
    if (!this.manifest) return;
    this.fetchPending = !0, this.startupGating = !0, this.video.paused || (this.video.pause(), this.setBuffering(!0)), this.activeSeekMode = i, this.previewParked = !1, this.bufferFull = !1, this.seekTargetFrame = Math.round(
      e * this.editRateNumerator / this.editRateDenominator
    ), this.pendingSeeks++, this.audio.onSeek();
    const t = { type: "seek", targetFrame: this.seekTargetFrame };
    this.worker.postMessage(t);
  }
  onTimeUpdate() {
    var t, s, r;
    if (!this.manifest) return;
    const e = this.video.currentTime;
    this.scrub.isActive || ((t = this.mseController) == null || t.trimBackBuffer(e), (s = this.mseController) == null || s.trimForwardOrphans(e, this.config.maxBufferSeconds + 5), this.bufferFull = !1), (((r = this.mseController) == null ? void 0 : r.getBufferedAhead("video", e)) ?? 0) < this.config.startBufferSeconds && (this.previewParked && !this.video.paused && !this.scrub.isActive ? this.initiateSeek(e, "accurate") : this.fetchNextChunk()), this.emit("timeupdate", { currentTime: e, duration: this.duration }), this.updateTimecode(e);
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
    const e = this.editRateNumerator / this.editRateDenominator, i = Math.round(this.manifest.duration * e), t = this.nextFetchFrame >= i, s = this.resumeTargetSeconds(), r = this.audio.bufferedAhead(this.video.currentTime), a = this.bufferedAhead(), n = this.nextFetchFrame / e - this.video.currentTime, d = t || n >= this.config.maxBufferSeconds, h = a >= s && (r >= s || d) || t;
    this.config.debug && this.log(`gate cur=${this.video.currentTime.toFixed(2)} v=${a.toFixed(2)} a=${r === 1 / 0 ? "inf" : r.toFixed(2)} target=${s.toFixed(2)} eof=${t} pending=${this.pendingSeeks} reqAhead=${n.toFixed(2)} stuck=${d} → ${h ? "PLAY" : "hold"} vbuf=${this.videoRanges()} abuf=${this.audio.debugStore()}`), h ? (this.startupGating = !1, this.setBuffering(!1), this.video.play().catch(() => {
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
  log(e) {
    this.config.debug && console.log("[mxf.js]", e);
  }
  /** Debug: the <video> element's buffered ranges as "[s1-e1][s2-e2]…" (a gap between ranges is the
   *  hang-then-skip symptom). */
  videoRanges() {
    const e = this.video.buffered;
    let i = "";
    for (let t = 0; t < e.length; t++) i += `[${e.start(t).toFixed(2)}-${e.end(t).toFixed(2)}]`;
    return i || "[]";
  }
  destroyInternal() {
    var e, i;
    (e = this.worker) == null || e.terminate(), this.worker = null, (i = this.mseController) == null || i.destroy(), this.mseController = null, this.audio.destroy(), this.manifest = null, this.nextFetchFrame = 0, this.fetchPending = !1, this.bufferFull = !1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.scrub.reset();
  }
  destroy() {
    this.destroyed = !0;
    const e = this.video;
    this.rvfcHandle && typeof e.cancelVideoFrameCallback == "function" && e.cancelVideoFrameCallback(this.rvfcHandle), this.rvfcHandle = 0, this.destroyInternal(), this.removeAllListeners(), this.emit("destroyed", void 0);
  }
}
export {
  _ as MxfPlayer,
  G as decodeSmpte12mBcd,
  F as formatTimecode,
  C as frameCountToTimecode,
  V as timecodeToFrameCount
};
//# sourceMappingURL=mxf.esm.js.map
