class b {
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
const R = 1, D = 0.5, A = 3, B = 6, P = R + 0.5;
class x extends b {
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
    const t = e - B;
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
        const o = r.buffered.start(a);
        o > i && this.evict(s, o, r.buffered.end(a));
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
        const r = i.buffered.length ? i.buffered.start(0) : s.start, a = i.buffered.length ? i.buffered.end(i.buffered.length - 1) : s.end, o = Math.max(s.start, r), d = Math.min(s.end, a);
        d > o ? i.remove(o, d) : (this.processing.set(e, !1), this.drainQueue(e));
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
    const a = this.video.currentTime - 2, o = i.buffered.length ? i.buffered.start(0) : 0;
    i.buffered.length > 0 && a > o + 0.5 ? (s.unshift({ kind: "remove", start: o, end: a }), this.drainQueue(e)) : (this.debug && console.warn(`[mse] ${e} buffer full — pausing fetch until playhead advances`), this.emit("bufferfull", void 0));
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
const I = 40, N = 0.25, O = 0.08, $ = 2, U = 30, m = class m {
  // edit units already received (duplicate probe)
  constructor(e, t, i = !1) {
    this.video = e, this.onAudioInfo = t, this.diag = i, this.cxt = null, this.timer = null, this.gainNode = null, this.volume = 1, this.anchored = !1, this.anchorCtx = 0, this.anchorMedia = 0, this.runId = 0, this.lastWall = -1, this.lastMedia = 0, this.store = [], this.channelCount = 0, this.active = [0, 1], this.editRateNumerator = 25, this.editRateDenominator = 1, this.diagBuf = [], this.diagHead = 0, this.diagSeq = 0, this.diagWarnAt = {}, this.schedCtxEnd = -1, this.arriveDur = -1, this.arriveCh = 0, this.arriveRate = 0, this.seenEU = /* @__PURE__ */ new Set();
  }
  setEditRate(e, t) {
    this.editRateNumerator = e, this.editRateDenominator = t;
  }
  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(e) {
    this.cxt = new AudioContext({ sampleRate: e }), this.gainNode = this.cxt.createGain(), this.gainNode.gain.value = this.volume, this.gainNode.connect(this.cxt.destination), this.timer || (this.timer = setInterval(() => this.tick(), I));
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
    this.anchored && this.cxt && !t.paused && !t.seeking && Math.abs(t.playbackRate - 1) <= 0.01 && this.pump(t.currentTime);
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
    const a = s * this.editRateDenominator / this.editRateNumerator, o = r / t, d = {
      mediaStart: a,
      mediaEnd: a + o,
      duration: o,
      samples: e,
      channelCount: i,
      sampleRate: t,
      source: null,
      lastRun: -1,
      scheduledOnce: !1
    };
    this.diag && (this.rec("arrive", !1, a, { eu: s, dur: +o.toFixed(5), ch: i, rate: t }), this.seenEU.has(s) ? this.rec("dup-eu", !0, a, { eu: s }) : this.seenEU.add(s), this.arriveRate && (i !== this.arriveCh || t !== this.arriveRate) && this.rec("param-change", !0, a, { ch: i, wasCh: this.arriveCh, rate: t, wasRate: this.arriveRate }), this.arriveDur > 0 && Math.abs(o - this.arriveDur) > this.arriveDur * 0.05 && this.rec("dur-jump", !0, a, { dur: +o.toFixed(5), was: +this.arriveDur.toFixed(5), samples: r }), this.arriveDur = o, this.arriveCh = i, this.arriveRate = t), this.insertChunk(d);
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
    const t = this.video, i = t.currentTime;
    if (this.evict(i), t.paused || t.seeking || Math.abs(t.playbackRate - 1) > 0.01) {
      this.anchored && this.unlock("gate"), this.lastWall = -1;
      return;
    }
    const s = e.currentTime;
    if (this.lastWall >= 0) {
      const r = s - this.lastWall, a = i - this.lastMedia;
      if (r > 5e-3 && a < 0.25 * r) {
        this.rec("stall", !0, i, { wallDelta: +r.toFixed(3), mediaDelta: +a.toFixed(3) }), this.anchored && this.unlock("stall"), this.lastWall = s, this.lastMedia = i;
        return;
      }
    }
    if (this.lastWall = s, this.lastMedia = i, !this.anchored)
      this.lockTo(i);
    else {
      const r = s - this.anchorCtx + this.anchorMedia;
      Math.abs(r - i) > O && this.lockTo(i);
    }
    this.diag && (this.store.some((a) => a.mediaStart <= i + 1e-6 && a.mediaEnd > i) || this.rec("underrun", !0, i, { chunks: this.store.length })), this.pump(i);
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
    const t = this.cxt, i = e + N, s = t.currentTime;
    for (const r of this.store) {
      if (r.mediaStart >= i) break;
      if (r.lastRun === this.runId) continue;
      if (r.lastRun = this.runId, r.mediaEnd <= e - 0.02) {
        this.diag && !r.scheduledOnce && e - r.mediaEnd < 0.5 && this.rec("drop", !0, r.mediaStart, { reason: "behind-unplayed", mediaEnd: +r.mediaEnd.toFixed(3) });
        continue;
      }
      const a = this.anchorCtx + (r.mediaStart - this.anchorMedia), o = s - a;
      if (o >= r.duration - 2e-3) {
        this.diag && !r.scheduledOnce && o - r.duration < 0.5 && this.rec("drop", !0, r.mediaStart, { reason: "missed", into: +o.toFixed(4), dur: +r.duration.toFixed(4) });
        continue;
      }
      const d = this.makeSource(r);
      if (d && (o <= 0 ? d.start(a) : d.start(s, o), r.source = d, r.scheduledOnce = !0, d.onended = () => {
        r.source = null;
      }, this.diag)) {
        const n = o <= 0 ? a + r.duration : s + (r.duration - o), c = this.schedCtxEnd >= 0 ? a - this.schedCtxEnd : 0;
        this.rec(
          "sched",
          this.schedCtxEnd >= 0 && Math.abs(c) > 1e-3,
          r.mediaStart,
          { mode: o <= 0 ? "future" : "straddle", gap: +c.toFixed(5), ctxStart: +a.toFixed(4), ctxEnd: +n.toFixed(4) }
        ), this.schedCtxEnd = n;
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
    const t = this.cxt, { samples: i, channelCount: s, sampleRate: r } = e, a = Math.floor(i.length / s), o = this.active.filter((f) => f < s);
    if (o.length === 0) return null;
    const d = [], n = [];
    o.forEach((f, p) => (p % 2 === 0 ? d : n).push(f)), o.length === 1 && (n.length = 0, n.push(o[0]));
    const c = t.createBuffer(2, a, r), l = (f, p) => {
      if (p.length !== 0)
        for (let g = 0; g < a; g++) {
          let y = 0;
          const E = g * s;
          for (const w of p) y += i[E + w];
          f[g] = y;
        }
    };
    l(c.getChannelData(0), d), l(c.getChannelData(1), n);
    const u = t.createBufferSource();
    return u.buffer = c, u.connect(this.gainNode ?? t.destination), u;
  }
  /** Drop chunks well behind or far ahead of the playhead to bound memory. */
  evict(e) {
    if (this.store.length === 0) return;
    const t = [];
    for (const i of this.store) {
      if (i.mediaEnd < e - $ || i.mediaStart > e + U) {
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
  dumpDiag(e = "") {
    var d;
    if (!this.diag) {
      console.warn("[audio-diag] diagnostics are off (construct WebAudioController with diag=true)");
      return;
    }
    const t = this.cxt ? this.cxt.currentTime : 0, i = this.video, s = i.currentTime, r = this.diagBuf.filter((n) => !!n && t - n.t <= m.DIAG_WINDOW).sort((n, c) => n.seq - c.seq), a = this.store.length ? { from: +this.store[0].mediaStart.toFixed(3), to: +this.store[this.store.length - 1].mediaEnd.toFixed(3), chunks: this.store.length } : { from: 0, to: 0, chunks: 0 };
    console.group(`[audio-diag] mark ${e} @ media=${s.toFixed(3)}s t=${t.toFixed(3)}s (${r.length} events / ${m.DIAG_WINDOW}s)`), console.log("state", {
      anchored: this.anchored,
      runId: this.runId,
      cxtState: (d = this.cxt) == null ? void 0 : d.state,
      paused: i.paused,
      seeking: i.seeking,
      rate: i.playbackRate,
      active: this.active.slice(),
      coverage: a
    }), console.table(r.map((n) => ({ dt: +(n.t - t).toFixed(3), type: n.type, media: +n.media.toFixed(3), anomaly: n.anomaly, ...n.detail })));
    const o = this.boundaryProbe(s);
    o.length && (console.log("tile-join discontinuities (mixed output; large jump = click in data/mix):"), console.table(o)), console.groupEnd();
  }
  /** Mixed-output discontinuity at each contiguous tile join near the playhead. A large jump = a click
   *  baked into the decoded PCM or the channel mix, not a scheduling fault. */
  boundaryProbe(e) {
    const t = 0.5 * this.editRateDenominator / this.editRateNumerator, i = [];
    for (let s = 0; s + 1 < this.store.length; s++) {
      const r = this.store[s], a = this.store[s + 1];
      if (r.mediaEnd < e - 1 || a.mediaStart > e + 1 || Math.abs(a.mediaStart - r.mediaEnd) > t) continue;
      const o = this.mixFrame(r, Math.floor(r.samples.length / r.channelCount) - 1), d = this.mixFrame(a, 0);
      i.push({ join: +r.mediaEnd.toFixed(3), jumpL: +Math.abs(o[0] - d[0]).toFixed(4), jumpR: +Math.abs(o[1] - d[1]).toFixed(4) });
    }
    return i;
  }
  /** The stereo [L,R] sample the active-channel mix produces for frame `i` of a chunk (mirrors makeSource). */
  mixFrame(e, t) {
    const i = this.active.filter((d) => d < e.channelCount);
    if (i.length === 0 || t < 0) return [0, 0];
    const s = [], r = [];
    i.forEach((d, n) => (n % 2 === 0 ? s : r).push(d)), i.length === 1 && (r.length = 0, r.push(i[0]));
    const a = t * e.channelCount, o = (d) => d.reduce((n, c) => n + e.samples[a + c], 0);
    return [o(s), o(r)];
  }
  /** Tear down the AudioContext and reset all state for the next file. */
  destroy() {
    var e;
    this.stopSources(), this.store = [], this.timer && (clearInterval(this.timer), this.timer = null), (e = this.cxt) == null || e.close().catch(() => {
    }), this.cxt = null, this.gainNode = null, this.anchored = !1, this.channelCount = 0, this.diagBuf = [], this.diagHead = 0, this.diagSeq = 0, this.diagWarnAt = {}, this.schedCtxEnd = -1, this.arriveDur = -1, this.arriveCh = 0, this.arriveRate = 0, this.seenEU.clear();
  }
};
m.DIAG_CAP = 512, m.DIAG_WINDOW = 3;
let k = m;
class L {
  constructor(e, t, i, s) {
    this.video = e, this.requestPreview = t, this.settle = i, this.resume = s, this.active = !1, this.cycle = 0, this.latestFrame = null, this.seq = 0, this.watchdog = null, this.wasPlaying = !1, this.suppressSeeking = !1, this.hasStream = !1, this.duration = 0, this.maxSeekTime = 0, this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  /** True while a scrub is in progress (beginScrub→endScrub). */
  get isActive() {
    return this.active;
  }
  /** Record stream parameters once the manifest arrives (enables scrubTo/endScrub). */
  setStream(e, t, i) {
    this.hasStream = !0, this.duration = e, this.editRateNumerator = t, this.editRateDenominator = i;
    const s = t / i, r = Math.round(e * s);
    this.maxSeekTime = Math.max(0, (r - 1) / s);
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
    const t = Math.max(0, Math.min(e, this.maxSeekTime));
    this.latestFrame = Math.round(t * this.editRateNumerator / this.editRateDenominator), this.pump();
  }
  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position). Moves
   * the playhead there, suppresses the resulting self-induced 'seeking', drives the accurate settle,
   * and resumes playback if it was running. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(e) {
    if (!this.active || (this.active = !1, this.latestFrame = null, this.cycle = 0, this.clearWatchdog(), !this.hasStream)) return;
    const t = Math.max(0, Math.min(e ?? this.video.currentTime, this.maxSeekTime));
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
function q(h, e) {
  const t = [];
  let i = !1, s = 0, r = 0, a = 0;
  const o = h.split(/\r?\n/);
  for (const d of o) {
    const n = d.trim();
    if (n.length !== 0) {
      if (n.startsWith("#")) {
        if (n.startsWith("#EXTINF:")) {
          const c = n.slice(8).split(",")[0], l = parseFloat(c);
          a = Number.isFinite(l) ? l : 0;
        } else if (n.startsWith("#EXT-X-TARGETDURATION:")) {
          const c = parseInt(n.slice(22), 10);
          Number.isFinite(c) && (r = c);
        } else if (n.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
          const c = parseInt(n.slice(22), 10);
          Number.isFinite(c) && (s = c);
        } else n === "#EXT-X-ENDLIST" && (i = !0);
        continue;
      }
      t.push({ uri: W(n, e), durationSec: a }), a = 0;
    }
  }
  return { segments: t, endList: i, mediaSequence: s, targetDuration: r };
}
function W(h, e) {
  try {
    return new URL(h, e).href;
  } catch {
    return h;
  }
}
const G = 1, _ = 3;
class V extends b {
  constructor(e) {
    super(), this.lastSeq = -1, this.pollTimer = null, this.pollSeconds = _, this.stopped = !1, this.totalEmitted = 0, this.manifestUrl = e;
  }
  /** Begin: fetch the manifest once, emit its clips, and (if live) start polling. */
  async start() {
    let e;
    try {
      e = await this.fetchAndParse();
    } catch (t) {
      this.emit("error", { message: `Playlist fetch failed: ${this.errMsg(t)}`, fatal: !0 });
      return;
    }
    if (!this.stopped) {
      if (this.applyPlaylist(e), e.endList) {
        this.emit("static-known", { totalClips: this.totalEmitted });
        return;
      }
      this.scheduleNextPoll();
    }
  }
  /** Stop polling and release resources. */
  destroy() {
    this.stopped = !0, this.pollTimer && (clearTimeout(this.pollTimer), this.pollTimer = null), this.removeAllListeners();
  }
  // ---------------------------------------------------------------------------
  async fetchAndParse() {
    const e = await fetch(this.manifestUrl, { cache: "no-store" });
    if (!e.ok) throw new Error(`HTTP ${e.status} ${e.statusText}`);
    const t = await e.text();
    return q(t, this.manifestUrl);
  }
  /** Emit any not-yet-seen clips from a parsed playlist and update poll cadence. */
  applyPlaylist(e) {
    e.targetDuration > 0 && (this.pollSeconds = Math.max(G, e.targetDuration));
    const t = [];
    e.segments.forEach((i, s) => {
      const r = e.mediaSequence + s;
      r <= this.lastSeq || (t.push({ url: i.uri, durationSec: i.durationSec, seq: r }), this.lastSeq = r);
    }), t.length > 0 && (this.totalEmitted += t.length, this.emit("clips-added", { clips: t }));
  }
  scheduleNextPoll() {
    this.stopped || (this.pollTimer = setTimeout(() => {
      this.poll();
    }, this.pollSeconds * 1e3));
  }
  async poll() {
    if (!this.stopped) {
      try {
        const e = await this.fetchAndParse();
        if (this.stopped) return;
        if (this.applyPlaylist(e), e.endList) {
          this.emit("static-known", { totalClips: this.totalEmitted });
          return;
        }
      } catch (e) {
        this.emit("error", { message: `Playlist poll failed: ${this.errMsg(e)}`, fatal: !1 });
      }
      this.scheduleNextPoll();
    }
  }
  errMsg(e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function S(h) {
  return (h < 10 ? "0" : "") + h;
}
function F(h, e) {
  return e && (h === 30 || h === 60);
}
function T(h) {
  return h === 60 ? 4 : 2;
}
function X(h) {
  const e = h.base;
  if (e <= 0) return 0;
  let t = ((h.hours * 60 + h.minutes) * 60 + h.seconds) * e + h.frames;
  if (F(e, h.dropFrame)) {
    const i = T(e), s = h.hours * 60 + h.minutes;
    t -= i * (s - Math.floor(s / 10));
  }
  return t;
}
function C(h, e, t) {
  if (e <= 0) return { hours: 0, minutes: 0, seconds: 0, frames: 0, dropFrame: !1, base: e };
  let i = h < 0 ? 0 : Math.floor(h);
  const s = F(e, t);
  if (s) {
    const n = T(e), c = e * 600 - n * 9, l = e * 60 - n, u = Math.floor(i / c), f = i % c;
    i += n * 9 * u + (f > n ? n * Math.floor((f - n) / l) : 0);
  }
  const r = i % e, a = Math.floor(i / e) % 60, o = Math.floor(i / (e * 60)) % 60;
  return { hours: Math.floor(i / (e * 3600)) % 24, minutes: o, seconds: a, frames: r, dropFrame: s, base: e };
}
function M(h) {
  const e = F(h.base, h.dropFrame) ? ";" : ":";
  return `${S(h.hours)}:${S(h.minutes)}:${S(h.seconds)}${e}${S(h.frames)}`;
}
function Q(h, e = 0) {
  if (h.length < 4) return null;
  const t = (h[0] & 15) + (h[0] >> 4 & 3) * 10, i = (h[0] & 64) !== 0, s = (h[1] & 15) + (h[1] >> 4 & 7) * 10, r = (h[2] & 15) + (h[2] >> 4 & 7) * 10;
  return { hours: (h[3] & 15) + (h[3] >> 4 & 3) * 10, minutes: r, seconds: s, frames: t, dropFrame: i, base: e };
}
const H = {
  mpeg2video: "mpeg2",
  h264: "h264",
  libx264: "h264"
};
function v(h) {
  const e = h.mxfCodec ?? H[h.ffmpegCodec] ?? h.ffmpegCodec;
  return { moduleUrl: h.moduleUrl, ffmpegCodec: h.ffmpegCodec, mxfCodec: e };
}
const j = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: "auto",
  seekMode: "accurate",
  resumeBufferSeconds: P,
  debug: !1,
  plugins: {}
};
class K extends b {
  constructor(e, t = {}) {
    super(), this.worker = null, this.mseController = null, this.manifest = null, this.nextFetchFrame = 0, this.framesPerChunk = 50, this.rampChunkFrames = 50, this.fetchPending = !1, this.bufferFull = !1, this.editRateNumerator = 25, this.editRateDenominator = 1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.rvfcHandle = 0, this.destroyed = !1, this.playlistMode = !1, this.playlist = null, this.staticPlaylist = !1, this.clips = [], this.nextRegisterIndex = 0, this.video = e, this.config = { ...j, ...t }, this.audio = new k(this.video, (i) => this.emit("audio-info", i), !!this.config.debug), this.scrub = new L(
      this.video,
      (i, s) => this.postScrubPreview(i, s),
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
    return M(C(i, t.base, t.dropFrame));
  }
  /** Build the full timecode bundle (system + computed package TCs) for a rendered edit unit. */
  computeTimecodeBundle(e) {
    var d;
    const t = [], i = this.systemTimecodeAt(e);
    i !== null && t.push({ source: "system", text: i, reliable: !0 });
    const s = ((d = this.manifest) == null ? void 0 : d.indexMode) !== "none", r = this.editRateNumerator / this.editRateDenominator;
    for (const n of this.manifestTimecodes) {
      const c = n.editRateDenominator > 0 ? n.editRateNumerator / n.editRateDenominator : r, l = r > 0 ? Math.round(e * (c / r)) : e, u = M(C(n.position + l, n.base, n.dropFrame));
      t.push({ source: n.source, text: u, reliable: s });
    }
    const a = { system: 0, material: 1, source: 2, file: 3 };
    t.sort((n, c) => a[n.source] - a[c.source]);
    const o = t.length ? { source: t[0].source, text: t[0].text } : null;
    return { editUnit: e, primary: o, all: t };
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
  /** Time (seconds) of the LAST displayable frame. `duration` is the END of that frame, so a seek to
   *  `duration` resolves to frame index `totalFrames` — one PAST the last valid frame (`totalFrames-1`).
   *  The worker can't decode a frame there and the element paints nothing (it clamps the playhead back
   *  to the buffered end → "no picture change" at the very end of the clip). Seek/scrub targets clamp
   *  to this instead so the end of the timeline lands on the real final frame. */
  get lastFrameTime() {
    if (!this.manifest) return 0;
    const e = this.editRateNumerator / this.editRateDenominator, t = this.totalFramesGlobal();
    return Math.max(0, (t - 1) / e);
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
    const t = Math.max(0, Math.min(e, this.lastFrameTime));
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
  loadUrl(e) {
    var s;
    this.setup();
    const t = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: v(this.config.plugins.videoDecoder) } : void 0, i = { type: "initUrl", url: e, debug: this.config.debug, videoMode: "mse", plugins: t };
    this.worker.postMessage(i);
  }
  loadFile(e) {
    var s;
    this.setup();
    const t = (s = this.config.plugins) != null && s.videoDecoder ? { videoDecoder: v(this.config.plugins.videoDecoder) } : void 0, i = { type: "initFile", file: e, debug: this.config.debug, videoMode: "mse", plugins: t };
    this.worker.postMessage(i);
  }
  /**
   * Load an HLS (m3u8) playlist of structurally-identical MXF clips and play them back-to-back
   * seamlessly on one continuous timeline. The first clip's header is parsed once and reused for every
   * other clip (no per-clip header re-parse); the shared init segment / transcode pipeline means MSE
   * sees one continuous stream across clip boundaries.
   *
   * Works for both a STATIC playlist (`#EXT-X-ENDLIST` — a full spanning timeline you can scrub across)
   * and a LIVE playlist (no ENDLIST — polled for new clips, HLS-live style). The mode is detected from
   * the manifest. The first clip's bytes start downloading immediately; later clips are fetched ahead
   * of the playhead so a clip boundary never stalls.
   */
  loadPlaylist(e) {
    this.setup(), this.playlistMode = !0, this.staticPlaylist = !1, this.clips = [], this.nextRegisterIndex = 0, this.playlist = new V(e), this.playlist.on("clips-added", ({ clips: t }) => this.onClipsAdded(t)), this.playlist.on("static-known", () => {
      this.staticPlaylist = !0, this.updatePlaylistDuration();
    }), this.playlist.on("error", ({ message: t, fatal: i }) => this.emit("error", { message: t, fatal: i })), this.playlist.start();
  }
  /** New clips surfaced by the playlist controller — append them and drive sequential registration. */
  onClipsAdded(e) {
    var i;
    const t = this.clips.length === 0;
    for (const s of e)
      this.clips.push({ url: s.url, frameOffset: null, frameCount: null, state: "pending" });
    if (t && this.clips.length > 0) {
      this.clips[0].frameOffset = 0, this.clips[0].state = "registering";
      const s = (i = this.config.plugins) != null && i.videoDecoder ? { videoDecoder: v(this.config.plugins.videoDecoder) } : void 0;
      this.worker.postMessage({ type: "initPlaylist", url: this.clips[0].url, debug: this.config.debug, plugins: s }), this.nextRegisterIndex = 1;
    } else
      this.pumpClipRegistration();
  }
  /** Register the next pending clip with the worker, once the previous clip's offset is known. One at a
   *  time: each clip's frameOffset = previous clip's frameOffset + frameCount, known only on clipReady. */
  pumpClipRegistration() {
    const e = this.nextRegisterIndex;
    if (e <= 0 || e >= this.clips.length) return;
    const t = this.clips[e - 1];
    if (t.frameOffset === null || t.frameCount === null) return;
    const i = this.clips[e];
    i.state === "pending" && (i.frameOffset = t.frameOffset + t.frameCount, i.state = "registering", this.worker.postMessage({ type: "registerClip", clipIndex: e, url: i.url }));
  }
  /** A clip's worker bootstrap finished: record its length, advance the registration pump, refresh the
   *  timeline duration, and (in case the playhead was waiting at the frontier) kick a forward fetch. */
  onClipReady(e, t) {
    const i = this.clips[e];
    i && (i.frameCount = t, i.state = "ready", this.nextRegisterIndex = Math.max(this.nextRegisterIndex, e + 1), this.pumpClipRegistration(), this.updatePlaylistDuration(), this.fetchNextChunk());
  }
  onClipFailed(e) {
    const t = this.clips[e];
    t && (t.state = "failed"), t && t.frameOffset !== null && (t.frameCount = 0), this.nextRegisterIndex = Math.max(this.nextRegisterIndex, e + 1), this.pumpClipRegistration();
  }
  /** Recompute and publish the MSE timeline duration from the registered clips' total frame count. */
  updatePlaylistDuration() {
    var i;
    if (!this.playlistMode || !this.manifest) return;
    const e = this.editRateNumerator / this.editRateDenominator, t = this.totalFramesGlobal() / e;
    this.manifest.duration = t, (i = this.mseController) == null || i.setDuration(t);
  }
  /** Resolve the clip owning a GLOBAL edit unit: the last ready clip whose frameOffset ≤ frame and
   *  that contains it. Returns null when the frame is past every registered clip (await more). */
  clipForGlobalFrame(e) {
    for (let t = 0; t < this.clips.length; t++) {
      const i = this.clips[t];
      if (i.state !== "ready" || i.frameOffset === null || i.frameCount === null) break;
      if (e >= i.frameOffset && e < i.frameOffset + i.frameCount)
        return { clipIndex: t, frameOffset: i.frameOffset, frameCount: i.frameCount };
    }
    return null;
  }
  /** Total frames on the global timeline: playlist → sum of ready clips; single-file → clip 0 length. */
  totalFramesGlobal() {
    if (this.playlistMode) {
      let e = 0;
      for (const t of this.clips)
        if (t.state === "ready" && t.frameCount !== null) e += t.frameCount;
        else break;
      return e;
    }
    return this.manifest ? Math.round(this.manifest.duration * this.editRateNumerator / this.editRateDenominator) : 0;
  }
  setup() {
    this.destroyInternal(), this.worker = this.createWorker(), this.worker.addEventListener("message", (e) => this.onWorkerMessage(e.data)), this.worker.addEventListener("error", (e) => {
      var i;
      const t = [
        e.message,
        e.filename && `${e.filename}:${e.lineno ?? "?"}:${e.colno ?? "?"}`,
        (i = e.error) == null ? void 0 : i.stack
      ].filter(Boolean).join(" — ");
      console.error("[mxf.js] worker error:", e, e.error), this.emit("error", {
        message: t || "Worker failed to load — reload the page (the dev server may have restarted)",
        fatal: !0
      });
    }), this.worker.addEventListener("messageerror", (e) => {
      this.emit("error", { message: `Worker message error: ${String(e)}`, fatal: !0 });
    }), this.mseController = new x(this.video, !!this.config.debug), this.mseController.on("error", ({ track: e, message: t }) => {
      this.emit("error", { message: `MSE ${e}: ${t}`, fatal: !1 });
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
        const o = e.nearestKeyframeEditUnit;
        if (this.nextFetchFrame = o, this.fetchPending = !1, this.activeSeekMode === "keyframe") {
          const n = Math.max(e.gopFrameCount, this.seekTargetFrame - o + 1, 1);
          this.fetchKeyframePreview(o, n);
          break;
        }
        const d = Math.min(
          this.framesPerChunk,
          Math.max(1, this.seekTargetFrame - o + 3)
        );
        this.fetchNextChunk(d);
        break;
      }
      case "previewDone":
        this.scrub.onPreviewDone(e.editUnit);
        break;
      case "clipReady":
        this.onClipReady(e.clipIndex, e.frameCount);
        break;
      case "clipFailed":
        this.onClipFailed(e.clipIndex);
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
    var d, n;
    const t = e.pictureDescriptor, i = e.soundDescriptor;
    this.editRateNumerator = e.editRateNumerator, this.editRateDenominator = e.editRateDenominator, this.audio.setEditRate(e.editRateNumerator, e.editRateDenominator), this.scrub.setStream(e.duration, e.editRateNumerator, e.editRateDenominator);
    const s = e.editRateNumerator / e.editRateDenominator;
    this.framesPerChunk = Math.ceil(s * R), this.rampChunkFrames = Math.max(A, Math.ceil(s * D)), this.startupGating = !0, this.manifestTimecodes = e.timecodes ?? [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.manifest = {
      duration: e.duration,
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
      timecodes: e.timecodes ?? []
    }, this.playlistMode && this.clips.length > 0 && (this.clips[0].frameOffset = 0, this.clips[0].frameCount = Math.round(e.duration * s), this.clips[0].state = "ready", this.nextRegisterIndex = 1, this.pumpClipRegistration());
    const r = e.resolvedVideoCodec ?? (t == null ? void 0 : t.codec) ?? "unknown", a = t && e.videoCodecSupported ? x.getMimeType("video", r) : null;
    let o = i ? x.getMimeType("audio", i.codec) : null;
    (i == null ? void 0 : i.codec) === "pcm" && (this.config.pcmAudioMode === "webaudio" || !o) && (o = null, this.audio.createContext(i.sampleRate)), this.audio.applyChannelCount(e.audioChannelCount);
    try {
      await this.mseController.open(a, o);
    } catch (c) {
      this.emit("error", { message: `MSE open failed: ${c}`, fatal: !0 });
      return;
    }
    this.mseController.setDuration(e.duration), this.pendingInitSegment ? ((d = this.mseController) == null || d.appendSegment("video", this.pendingInitSegment), (n = this.mseController) == null || n.appendSegment("audio", this.pendingInitSegment), this.pendingInitSegment = null, this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${i == null ? void 0 : i.codec}`), this.fetchNextChunk()) : (this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${i == null ? void 0 : i.codec}`));
  }
  /**
   * Fetch a single I-frame at `keyframe` for a fast scrub preview, telling the worker to stretch
   * that one decoded sample across `stretchFrames` frame periods so it covers its whole GOP on the
   * MSE timeline. Posted directly (not via fetchNextChunk) so it isn't gated by the scrub guard.
   */
  fetchKeyframePreview(e, t) {
    if (!this.manifest) return;
    this.previewParked = !0, this.nextFetchFrame = e;
    let i = e, s;
    if (this.playlistMode) {
      const a = this.clipForGlobalFrame(e);
      if (!a) return;
      i = e - a.frameOffset, s = { clipIndex: a.clipIndex, frameOffset: a.frameOffset };
    }
    const r = {
      type: "fetchSegment",
      startFrame: i,
      frameCount: 1,
      seqBase: this.seqBase,
      stretchToFrames: t,
      ...s ?? {}
    };
    this.seqBase += 2, this.worker.postMessage(r);
  }
  /** Post a scrub-preview request, mapping the GLOBAL drag frame to (clip, local) in playlist mode. */
  postScrubPreview(e, t) {
    if (this.worker) {
      if (this.playlistMode) {
        const i = this.clipForGlobalFrame(e) ?? this.clipForGlobalFrame(Math.max(0, this.totalFramesGlobal() - 1));
        if (i) {
          this.worker.postMessage({
            type: "scrubPreview",
            targetFrame: e - i.frameOffset,
            seq: t,
            clipIndex: i.clipIndex,
            frameOffset: i.frameOffset
          });
          return;
        }
      }
      this.worker.postMessage({ type: "scrubPreview", targetFrame: e, seq: t });
    }
  }
  fetchNextChunk(e) {
    var l;
    if (this.scrub.isActive || this.previewParked || this.bufferFull || this.fetchPending || !this.manifest) return;
    const t = this.video.currentTime, i = this.editRateNumerator / this.editRateDenominator;
    if (this.nextFetchFrame / i - t >= this.config.maxBufferSeconds) return;
    const r = this.totalFramesGlobal();
    if (this.nextFetchFrame >= r) {
      if (this.playlistMode && !this.staticPlaylist) return;
      (l = this.mseController) == null || l.endOfStream();
      return;
    }
    let a = e ?? this.nextRampChunk(), o = 0, d = 0, n = this.nextFetchFrame;
    if (this.playlistMode) {
      const u = this.clipForGlobalFrame(this.nextFetchFrame);
      if (!u) return;
      o = u.clipIndex, d = u.frameOffset, n = this.nextFetchFrame - u.frameOffset;
      const f = u.frameOffset + u.frameCount - this.nextFetchFrame;
      if (a = Math.min(a, f), a <= 0) return;
    }
    this.fetchPending = !0;
    const c = {
      type: "fetchSegment",
      startFrame: n,
      frameCount: a,
      seqBase: this.seqBase,
      ...this.playlistMode ? { clipIndex: o, frameOffset: d } : {}
    };
    this.seqBase += 2, this.nextFetchFrame += a, this.worker.postMessage(c);
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
    this.fetchPending = !0, this.startupGating = !0, this.video.paused || (this.video.pause(), this.setBuffering(!0)), this.activeSeekMode = t, this.previewParked = !1, this.bufferFull = !1;
    const i = this.totalFramesGlobal();
    this.seekTargetFrame = Math.max(0, Math.min(
      Math.round(e * this.editRateNumerator / this.editRateDenominator),
      i - 1
    )), this.pendingSeeks++, this.audio.onSeek();
    let s = { type: "seek", targetFrame: this.seekTargetFrame };
    if (this.playlistMode) {
      const r = this.clipForGlobalFrame(this.seekTargetFrame) ?? this.clipForGlobalFrame(Math.max(0, this.totalFramesGlobal() - 1));
      r && (s = {
        type: "seek",
        targetFrame: this.seekTargetFrame - r.frameOffset,
        clipIndex: r.clipIndex,
        frameOffset: r.frameOffset
      });
    }
    this.worker.postMessage(s);
  }
  onTimeUpdate() {
    var i, s, r;
    if (!this.manifest) return;
    const e = this.video.currentTime;
    this.scrub.isActive || ((i = this.mseController) == null || i.trimBackBuffer(e), (s = this.mseController) == null || s.trimForwardOrphans(e, this.config.maxBufferSeconds + 5), this.bufferFull = !1), (((r = this.mseController) == null ? void 0 : r.getBufferedAhead("video", e)) ?? 0) < this.config.startBufferSeconds && (this.previewParked && !this.video.paused && !this.scrub.isActive ? this.initiateSeek(e, "accurate") : this.fetchNextChunk()), this.emit("timeupdate", { currentTime: e, duration: this.duration }), this.updateTimecode(e);
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
    const e = this.editRateNumerator / this.editRateDenominator, t = this.totalFramesGlobal(), i = this.nextFetchFrame >= t && (!this.playlistMode || this.staticPlaylist), s = this.resumeTargetSeconds(), r = this.audio.bufferedAhead(this.video.currentTime), a = this.bufferedAhead(), o = this.nextFetchFrame / e - this.video.currentTime, d = i || o >= this.config.maxBufferSeconds, n = a >= s && (r >= s || d) || i;
    this.config.debug && this.log(`gate cur=${this.video.currentTime.toFixed(2)} v=${a.toFixed(2)} a=${r === 1 / 0 ? "inf" : r.toFixed(2)} target=${s.toFixed(2)} eof=${i} pending=${this.pendingSeeks} reqAhead=${o.toFixed(2)} stuck=${d} → ${n ? "PLAY" : "hold"} vbuf=${this.videoRanges()} abuf=${this.audio.debugStore()}`), n ? (this.startupGating = !1, this.setBuffering(!1), this.video.play().catch(() => {
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
    let t = "";
    for (let i = 0; i < e.length; i++) t += `[${e.start(i).toFixed(2)}-${e.end(i).toFixed(2)}]`;
    return t || "[]";
  }
  destroyInternal() {
    var e, t, i;
    (e = this.playlist) == null || e.destroy(), this.playlist = null, this.playlistMode = !1, this.staticPlaylist = !1, this.clips = [], this.nextRegisterIndex = 0, (t = this.worker) == null || t.terminate(), this.worker = null, (i = this.mseController) == null || i.destroy(), this.mseController = null, this.audio.destroy(), this.manifest = null, this.nextFetchFrame = 0, this.fetchPending = !1, this.bufferFull = !1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.scrub.reset();
  }
  destroy() {
    this.destroyed = !0;
    const e = this.video;
    this.rvfcHandle && typeof e.cancelVideoFrameCallback == "function" && e.cancelVideoFrameCallback(this.rvfcHandle), this.rvfcHandle = 0, this.destroyInternal(), this.removeAllListeners(), this.emit("destroyed", void 0);
  }
}
export {
  K as MxfPlayer,
  Q as decodeSmpte12mBcd,
  M as formatTimecode,
  C as frameCountToTimecode,
  X as timecodeToFrameCount
};
//# sourceMappingURL=mxf.esm.js.map
