class C {
  constructor() {
    this.listeners = /* @__PURE__ */ new Map();
  }
  on(e, t) {
    const s = String(e);
    return this.listeners.has(s) || this.listeners.set(s, /* @__PURE__ */ new Set()), this.listeners.get(s).add(t), this;
  }
  off(e, t) {
    var s;
    return (s = this.listeners.get(String(e))) == null || s.delete(t), this;
  }
  once(e, t) {
    const s = (i) => {
      t(i), this.off(e, s);
    };
    return this.on(e, s);
  }
  emit(e, t) {
    var s;
    (s = this.listeners.get(String(e))) == null || s.forEach((i) => {
      try {
        i(t);
      } catch {
      }
    });
  }
  removeAllListeners() {
    this.listeners.clear();
  }
}
const T = 2, B = 0.25, w = 3, A = 6, D = 0.75;
class S extends C {
  constructor(e, t = !1) {
    super(), this.mediaSource = null, this.objectURL = null, this.sourceBuffers = /* @__PURE__ */ new Map(), this.queues = /* @__PURE__ */ new Map(), this.processing = /* @__PURE__ */ new Map(), this.video = e, this.debug = t;
  }
  open(e, t) {
    return new Promise((s, i) => {
      this.mediaSource = new MediaSource(), this.objectURL = URL.createObjectURL(this.mediaSource), this.video.src = this.objectURL, this.mediaSource.addEventListener("sourceopen", () => {
        try {
          e && MediaSource.isTypeSupported(e) && this.addSourceBuffer("video", e), t && MediaSource.isTypeSupported(t) && this.addSourceBuffer("audio", t), s();
        } catch (r) {
          i(r);
        }
      }, { once: !0 }), this.mediaSource.addEventListener("error", () => i(new Error("MediaSource error")), { once: !0 });
    });
  }
  addSourceBuffer(e, t) {
    this.debug && console.log(`[mse] addSourceBuffer ${e} "${t}"`);
    const s = this.mediaSource.addSourceBuffer(t);
    this.sourceBuffers.set(e, s), this.queues.set(e, []), this.processing.set(e, !1), s.addEventListener("updateend", () => {
      this.processing.set(e, !1), this.emit("appended", { track: e }), this.drainQueue(e);
    }), s.addEventListener("error", () => {
      const i = `SourceBuffer error on ${e} track — codec may be unsupported or data is malformed`;
      console.error(`[mxf.js] ${i}`), this.emit("error", { track: e, message: i });
    });
  }
  appendSegment(e, t) {
    const s = this.queues.get(e);
    s && (s.push({ kind: "append", data: t }), this.drainQueue(e));
  }
  /** Queue a removal of buffered media in [start, end) for a track (used to cap buffer growth). */
  evict(e, t, s) {
    const i = this.queues.get(e);
    !i || s <= t || (i.push({ kind: "remove", start: t, end: s }), this.drainQueue(e));
  }
  /**
   * Evict already-played media older than `BACK_BUFFER_SECONDS` behind `currentTime` on every track,
   * keeping the resident buffer bounded. Called as playback advances. No-op if there's nothing old
   * enough to remove.
   */
  trimBackBuffer(e) {
    const t = e - A;
    if (!(t <= 0))
      for (const [s, i] of this.sourceBuffers) {
        if (i.buffered.length === 0) continue;
        const r = i.buffered.start(0);
        t > r + 0.5 && this.evict(s, r, t);
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
    const s = e + t;
    for (const [i, r] of this.sourceBuffers)
      for (let a = r.buffered.length - 1; a >= 0; a--) {
        const o = r.buffered.start(a);
        o > s && this.evict(i, o, r.buffered.end(a));
      }
  }
  drainQueue(e) {
    if (this.processing.get(e)) return;
    const t = this.queues.get(e), s = this.sourceBuffers.get(e);
    if (!t || !s || t.length === 0 || s.updating) return;
    const i = t[0];
    this.processing.set(e, !0);
    try {
      if (i.kind === "append")
        t.shift(), s.appendBuffer(i.data);
      else {
        t.shift();
        const r = s.buffered.length ? s.buffered.start(0) : i.start, a = s.buffered.length ? s.buffered.end(s.buffered.length - 1) : i.end, o = Math.max(i.start, r), u = Math.min(i.end, a);
        u > o ? s.remove(o, u) : (this.processing.set(e, !1), this.drainQueue(e));
      }
    } catch (r) {
      this.processing.set(e, !1), i.kind === "append" && (r == null ? void 0 : r.name) === "QuotaExceededError" ? this.handleQuota(e, i.data) : console.error(`appendBuffer error (${e}):`, r);
    }
  }
  /**
   * The SourceBuffer is full. Free space by evicting media behind the playhead and retry the append.
   * If there's nothing behind to evict (the forward buffer alone is over quota — common for
   * high-bitrate all-intra like AVC-Intra), the segment can't be appended now: re-queue it at the
   * front and tell the player to stop fetching until the playhead advances and frees room.
   */
  handleQuota(e, t) {
    const s = this.sourceBuffers.get(e), i = this.queues.get(e);
    if (!s || !i) return;
    i.unshift({ kind: "append", data: t });
    const a = this.video.currentTime - 2, o = s.buffered.length ? s.buffered.start(0) : 0;
    s.buffered.length > 0 && a > o + 0.5 ? (i.unshift({ kind: "remove", start: o, end: a }), this.drainQueue(e)) : (this.debug && console.warn(`[mse] ${e} buffer full — pausing fetch until playhead advances`), this.emit("bufferfull", void 0));
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
        if ([...this.sourceBuffers.values()].some((s) => s.updating))
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
    const s = this.sourceBuffers.get(e);
    if (!s || s.buffered.length === 0) return 0;
    for (let i = 0; i < s.buffered.length; i++) {
      const r = s.buffered.start(i), a = s.buffered.end(i);
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
const E = 40, P = 0.25, N = 0.08, I = 2, U = 30;
class W {
  constructor(e, t) {
    this.video = e, this.onAudioInfo = t, this.cxt = null, this.timer = null, this.anchored = !1, this.anchorCtx = 0, this.anchorMedia = 0, this.runId = 0, this.lastWall = -1, this.lastMedia = 0, this.store = [], this.channelCount = 0, this.active = [0, 1], this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  setEditRate(e, t) {
    this.editRateNumerator = e, this.editRateDenominator = t;
  }
  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(e) {
    this.cxt = new AudioContext({ sampleRate: e }), this.timer || (this.timer = setInterval(() => this.tick(), E));
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
    this.unlock();
  }
  /** Total number of PCM channels in the loaded file (0 until audio starts arriving). */
  get channels() {
    return this.channelCount;
  }
  /** Source channels (0-based) currently routed to the stereo output. */
  get activeChannels() {
    return this.active.slice();
  }
  /**
   * Choose which source channels are played (0-based). Selected channels are mixed to stereo by
   * selection-order parity (1st→L, 2nd→R, 3rd→L…); a single channel plays centre; empty mutes.
   * Takes effect on the next tick (≤TICK_MS) by re-mixing the in-flight lookahead.
   */
  setActiveChannels(e) {
    this.active = [...new Set(e.filter((t) => Number.isInteger(t) && t >= 0))].sort((t, s) => t - s), this.stopSources(), this.runId++;
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
  schedule(e, t, s, i) {
    if (!this.cxt) return;
    this.applyChannelCount(s);
    const r = Math.floor(e.length / s);
    if (r <= 0) return;
    const a = i * this.editRateDenominator / this.editRateNumerator, o = r / t, u = {
      mediaStart: a,
      mediaEnd: a + o,
      duration: o,
      samples: e,
      channelCount: s,
      sampleRate: t,
      source: null,
      lastRun: -1
    };
    this.insertChunk(u);
  }
  /** Insert sorted by mediaStart, deduping a chunk we already hold for the same edit unit (re-fetch
   *  overlap on seek revisits would otherwise double the audio). */
  insertChunk(e) {
    const t = 0.5 * this.editRateDenominator / this.editRateNumerator;
    let s = 0, i = this.store.length;
    for (; s < i; ) {
      const o = s + i >> 1;
      this.store[o].mediaStart < e.mediaStart ? s = o + 1 : i = o;
    }
    const r = this.store[s - 1], a = this.store[s];
    r && Math.abs(r.mediaStart - e.mediaStart) < t || a && Math.abs(a.mediaStart - e.mediaStart) < t || this.store.splice(s, 0, e);
  }
  /** Stop and clear all scheduled audio (e.g. on seek, so nothing keeps playing at the old offset). */
  stopSources() {
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
  unlock() {
    this.stopSources(), this.anchored = !1, this.runId++;
  }
  /** Periodic scheduler: keep ~LOOKAHEAD seconds of audio scheduled ahead of the <video> playhead. */
  tick() {
    const e = this.cxt;
    if (!e) return;
    const t = this.video, s = t.currentTime;
    if (this.evict(s), t.paused || t.seeking || Math.abs(t.playbackRate - 1) > 0.01) {
      this.anchored && this.unlock(), this.lastWall = -1;
      return;
    }
    const i = e.currentTime;
    if (this.lastWall >= 0) {
      const r = i - this.lastWall, a = s - this.lastMedia;
      if (r > 5e-3 && a < 0.25 * r) {
        this.anchored && this.unlock(), this.lastWall = i, this.lastMedia = s;
        return;
      }
    }
    if (this.lastWall = i, this.lastMedia = s, !this.anchored)
      this.lockTo(s);
    else {
      const r = i - this.anchorCtx + this.anchorMedia;
      Math.abs(r - s) > N && this.lockTo(s);
    }
    this.pump(s);
  }
  lockTo(e) {
    this.stopSources(), this.runId++, this.anchorCtx = this.cxt.currentTime, this.anchorMedia = e, this.anchored = !0;
  }
  /** Schedule every not-yet-handled chunk whose window reaches into [cur, cur+LOOKAHEAD). */
  pump(e) {
    const t = this.cxt, s = e + P, i = t.currentTime;
    for (const r of this.store) {
      if (r.mediaStart >= s) break;
      if (r.lastRun === this.runId || (r.lastRun = this.runId, r.mediaEnd <= e - 0.02)) continue;
      const a = this.anchorCtx + (r.mediaStart - this.anchorMedia), o = i - a;
      if (o >= r.duration - 2e-3) continue;
      const u = this.makeSource(r);
      u && (o <= 0 ? u.start(a) : u.start(i, o), r.source = u, u.onended = () => {
        r.source = null;
      });
    }
  }
  /**
   * Mix a chunk's currently-active channels to a stereo AudioBuffer and wrap it in a source node.
   * Explicit mixing is more reliable than Web Audio's implicit down-mix (undefined for >6/non-standard
   * channel counts). Returns null if there is nothing to play (no active channels in range).
   */
  makeSource(e) {
    const t = this.cxt, { samples: s, channelCount: i, sampleRate: r } = e, a = Math.floor(s.length / i), o = this.active.filter((d) => d < i);
    if (o.length === 0) return null;
    const u = [], h = [];
    o.forEach((d, m) => (m % 2 === 0 ? u : h).push(d)), o.length === 1 && (h.length = 0, h.push(o[0]));
    const c = t.createBuffer(2, a, r), l = (d, m) => {
      if (m.length === 0) return;
      const R = 1 / m.length;
      for (let p = 0; p < a; p++) {
        let b = 0;
        const F = p * i;
        for (const x of m) b += s[F + x];
        d[p] = b * R;
      }
    };
    l(c.getChannelData(0), u), l(c.getChannelData(1), h);
    const f = t.createBufferSource();
    return f.buffer = c, f.connect(t.destination), f;
  }
  /** Drop chunks well behind or far ahead of the playhead to bound memory. */
  evict(e) {
    if (this.store.length === 0) return;
    const t = [];
    for (const s of this.store) {
      if (s.mediaEnd < e - I || s.mediaStart > e + U) {
        if (s.source)
          try {
            s.source.onended = null, s.source.stop();
          } catch {
          }
        continue;
      }
      t.push(s);
    }
    this.store = t;
  }
  /** Tear down the AudioContext and reset all state for the next file. */
  destroy() {
    var e;
    this.stopSources(), this.store = [], this.timer && (clearInterval(this.timer), this.timer = null), (e = this.cxt) == null || e.close().catch(() => {
    }), this.cxt = null, this.anchored = !1, this.channelCount = 0;
  }
}
class q {
  constructor(e, t, s, i) {
    this.video = e, this.requestPreview = t, this.settle = s, this.resume = i, this.active = !1, this.cycle = 0, this.latestFrame = null, this.seq = 0, this.watchdog = null, this.wasPlaying = !1, this.suppressSeeking = !1, this.hasStream = !1, this.duration = 0, this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  /** True while a scrub is in progress (beginScrub→endScrub). */
  get isActive() {
    return this.active;
  }
  /** Record stream parameters once the manifest arrives (enables scrubTo/endScrub). */
  setStream(e, t, s) {
    this.hasStream = !0, this.duration = e, this.editRateNumerator = t, this.editRateDenominator = s;
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
function g(n) {
  return (n < 10 ? "0" : "") + n;
}
function k(n, e) {
  return e && (n === 30 || n === 60);
}
function y(n) {
  return n === 60 ? 4 : 2;
}
function $(n) {
  const e = n.base;
  if (e <= 0) return 0;
  let t = ((n.hours * 60 + n.minutes) * 60 + n.seconds) * e + n.frames;
  if (k(e, n.dropFrame)) {
    const s = y(e), i = n.hours * 60 + n.minutes;
    t -= s * (i - Math.floor(i / 10));
  }
  return t;
}
function v(n, e, t) {
  if (e <= 0) return { hours: 0, minutes: 0, seconds: 0, frames: 0, dropFrame: !1, base: e };
  let s = n < 0 ? 0 : Math.floor(n);
  const i = k(e, t);
  if (i) {
    const h = y(e), c = e * 600 - h * 9, l = e * 60 - h, f = Math.floor(s / c), d = s % c;
    s += h * 9 * f + (d > h ? h * Math.floor((d - h) / l) : 0);
  }
  const r = s % e, a = Math.floor(s / e) % 60, o = Math.floor(s / (e * 60)) % 60;
  return { hours: Math.floor(s / (e * 3600)) % 24, minutes: o, seconds: a, frames: r, dropFrame: i, base: e };
}
function M(n) {
  const e = k(n.base, n.dropFrame) ? ";" : ":";
  return `${g(n.hours)}:${g(n.minutes)}:${g(n.seconds)}${e}${g(n.frames)}`;
}
function V(n, e = 0) {
  if (n.length < 4) return null;
  const t = (n[0] & 15) + (n[0] >> 4 & 3) * 10, s = (n[0] & 64) !== 0, i = (n[1] & 15) + (n[1] >> 4 & 7) * 10, r = (n[2] & 15) + (n[2] >> 4 & 7) * 10;
  return { hours: (n[3] & 15) + (n[3] >> 4 & 3) * 10, minutes: r, seconds: i, frames: t, dropFrame: s, base: e };
}
const L = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: "auto",
  seekMode: "accurate",
  resumeBufferSeconds: D,
  debug: !1
};
class O extends C {
  constructor(e, t = {}) {
    super(), this.worker = null, this.mseController = null, this.manifest = null, this.nextFetchFrame = 0, this.framesPerChunk = 50, this.rampChunkFrames = 50, this.fetchPending = !1, this.bufferFull = !1, this.editRateNumerator = 25, this.editRateDenominator = 1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.rvfcHandle = 0, this.destroyed = !1, this.video = e, this.config = { ...L, ...t }, this.audio = new W(this.video, (s) => this.emit("audio-info", s)), this.scrub = new q(
      this.video,
      (s, i) => {
        var r;
        return (r = this.worker) == null ? void 0 : r.postMessage({ type: "scrubPreview", targetFrame: s, seq: i });
      },
      (s) => this.initiateSeek(s, "accurate"),
      () => this.play()
    ), this.video.addEventListener("seeking", () => this.onVideoSeeking()), this.video.addEventListener("seeked", () => this.onVideoSeeked()), this.video.addEventListener("timeupdate", () => this.onTimeUpdate()), this.video.addEventListener("waiting", () => this.onVideoWaiting()), this.video.addEventListener("playing", () => {
      this.startupGating = !1, this.setBuffering(!1);
    }), this.video.addEventListener("canplay", () => this.maybeResumePlayback()), this.video.addEventListener("play", () => {
      this.playIntent = !0, this.audio.resume();
    }), this.startVideoFrameCallback();
  }
  startVideoFrameCallback() {
    const e = this.video;
    if (typeof e.requestVideoFrameCallback != "function") return;
    const t = (s, i) => {
      this.destroyed || (this.updateTimecode(i.mediaTime), this.rvfcHandle = e.requestVideoFrameCallback(t));
    };
    this.rvfcHandle = e.requestVideoFrameCallback(t);
  }
  /**
   * Resolve the timecode bundle for the frame at `timeSeconds` and emit `timecode` on change. Fed by
   * both rVFC (mediaTime, exact) and timeupdate (currentTime, fallback); deduped by edit unit so the
   * two never double-emit. The edit unit is `round(time × fps)` — exact for any rendered frame
   * because every fMP4 sample timestamp is edit-unit-derived.
   */
  updateTimecode(e) {
    if (!this.manifest) return;
    const t = this.editRateNumerator / this.editRateDenominator;
    if (!(t > 0)) return;
    const s = Math.max(0, Math.round(e * t));
    if (s === this.lastTimecodeEditUnit) return;
    this.lastTimecodeEditUnit = s;
    const i = this.computeTimecodeBundle(s);
    this.currentTimecodeBundle = i, this.emit("timecode", i);
  }
  /** System Item timecode at a presentation edit unit: nearest preceding anchor + linear offset. */
  systemTimecodeAt(e) {
    let t = null;
    for (const i of this.systemAnchors)
      i.editUnit <= e && (!t || i.editUnit > t.editUnit) && (t = i);
    if (!t) return null;
    const s = t.frameCount + (e - t.editUnit);
    return M(v(s, t.base, t.dropFrame));
  }
  /** Build the full timecode bundle (system + computed package TCs) for a rendered edit unit. */
  computeTimecodeBundle(e) {
    var u;
    const t = [], s = this.systemTimecodeAt(e);
    s !== null && t.push({ source: "system", text: s, reliable: !0 });
    const i = ((u = this.manifest) == null ? void 0 : u.indexMode) !== "none", r = this.editRateNumerator / this.editRateDenominator;
    for (const h of this.manifestTimecodes) {
      const c = h.editRateDenominator > 0 ? h.editRateNumerator / h.editRateDenominator : r, l = r > 0 ? Math.round(e * (c / r)) : e, f = M(v(h.position + l, h.base, h.dropFrame));
      t.push({ source: h.source, text: f, reliable: i });
    }
    const a = { system: 0, material: 1, source: 2, file: 3 };
    t.sort((h, c) => a[h.source] - a[c.source]);
    const o = t.length ? { source: t[0].source, text: t[0].text } : null;
    return { editUnit: e, primary: o, all: t };
  }
  /** The most recently computed timecode bundle for the frame on screen (null before playback). */
  get currentTimecode() {
    return this.currentTimecodeBundle;
  }
  /** Merge fresh System Item anchors, keeping the list sorted/deduped by edit unit and bounded. */
  mergeSystemAnchors(e) {
    for (const s of e) {
      const i = this.systemAnchors.findIndex((r) => r.editUnit === s.editUnit);
      i >= 0 ? this.systemAnchors[i] = s : this.systemAnchors.push(s);
    }
    this.systemAnchors.sort((s, i) => s.editUnit - i.editUnit);
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
    this.playIntent = !1, this.video.pause(), this.audio.onSeek(), this.audio.suspend(), this.setBuffering(!1);
  }
  /** Seek to a time in seconds. The <video> 'seeking' event drives the worker fetch. */
  seek(e) {
    if (!this.manifest) return;
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
  loadUrl(e) {
    this.setup();
    const t = { type: "initUrl", url: e, debug: this.config.debug, videoMode: "mse" };
    this.worker.postMessage(t);
  }
  loadFile(e) {
    this.setup();
    const t = { type: "initFile", file: e, debug: this.config.debug, videoMode: "mse" };
    this.worker.postMessage(t);
  }
  setup() {
    this.destroyInternal(), this.worker = this.createWorker(), this.worker.addEventListener("message", (e) => this.onWorkerMessage(e.data)), this.worker.addEventListener("error", (e) => {
      var s;
      const t = [
        e.message,
        e.filename && `${e.filename}:${e.lineno ?? "?"}:${e.colno ?? "?"}`,
        (s = e.error) == null ? void 0 : s.stack
      ].filter(Boolean).join(" — ");
      console.error("[mxf.js] worker error:", e, e.error), this.emit("error", {
        message: t || "Worker failed to load — reload the page (the dev server may have restarted)",
        fatal: !0
      });
    }), this.worker.addEventListener("messageerror", (e) => {
      this.emit("error", { message: `Worker message error: ${String(e)}`, fatal: !0 });
    }), this.mseController = new S(this.video, !!this.config.debug), this.mseController.on("error", ({ track: e, message: t }) => {
      this.emit("error", { message: `MSE ${e}: ${t}`, fatal: !1 });
    }), this.mseController.on("bufferfull", () => {
      this.bufferFull = !0, this.fetchPending = !1;
    }), this.mseController.on("appended", ({ track: e }) => {
      e === "video" && this.playIntent && this.video.paused && this.maybeResumePlayback();
    });
  }
  createWorker() {
    const e = new URL("./demux-worker.js", import.meta.url);
    return new Worker(e);
  }
  async onWorkerMessage(e) {
    var t, s, i, r, a;
    switch (e.type) {
      case "manifest":
        await this.onManifest(e);
        break;
      case "initSegment":
        (t = this.mseController) != null && t.hasVideoBuffer() || (s = this.mseController) != null && s.hasAudioBuffer() ? (this.mseController.appendSegment("video", e.data), this.mseController.appendSegment("audio", e.data), this.fetchNextChunk()) : this.pendingInitSegment = e.data;
        break;
      case "videoSegment":
        (i = this.mseController) == null || i.appendSegment("video", e.data), (r = e.systemTcAnchors) != null && r.length && this.mergeSystemAnchors(e.systemTcAnchors), e.nextFrame !== void 0 && !this.scrub.isActive && !this.previewParked && (this.nextFetchFrame = e.nextFrame), this.playIntent && this.video.paused && this.maybeResumePlayback();
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
          const h = Math.max(e.gopFrameCount, this.seekTargetFrame - o + 1, 1);
          this.fetchKeyframePreview(o, h);
          break;
        }
        const u = Math.min(
          this.framesPerChunk,
          Math.max(1, this.seekTargetFrame - o + 3)
        );
        this.fetchNextChunk(u);
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
    var u, h;
    const t = e.pictureDescriptor, s = e.soundDescriptor;
    this.editRateNumerator = e.editRateNumerator, this.editRateDenominator = e.editRateDenominator, this.audio.setEditRate(e.editRateNumerator, e.editRateDenominator), this.scrub.setStream(e.duration, e.editRateNumerator, e.editRateDenominator);
    const i = e.editRateNumerator / e.editRateDenominator;
    this.framesPerChunk = Math.ceil(i * T), this.rampChunkFrames = Math.max(w, Math.ceil(i * B)), this.startupGating = !0, this.manifestTimecodes = e.timecodes ?? [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.manifest = {
      duration: e.duration,
      editRateNumerator: e.editRateNumerator,
      editRateDenominator: e.editRateDenominator,
      tracks: e.tracks,
      pictureDescriptor: t,
      soundDescriptor: s,
      displayWidth: e.displayWidth,
      displayHeight: e.displayHeight,
      aspectRatio: e.aspectRatio,
      indexMode: e.indexMode,
      longGop: e.longGop,
      timecodes: e.timecodes ?? []
    };
    const r = e.resolvedVideoCodec ?? (t == null ? void 0 : t.codec) ?? "unknown", a = t && e.videoCodecSupported ? S.getMimeType("video", r) : null;
    let o = s ? S.getMimeType("audio", s.codec) : null;
    (s == null ? void 0 : s.codec) === "pcm" && (this.config.pcmAudioMode === "webaudio" || !o) && (o = null, this.audio.createContext(s.sampleRate)), this.audio.applyChannelCount(e.audioChannelCount);
    try {
      await this.mseController.open(a, o);
    } catch (c) {
      this.emit("error", { message: `MSE open failed: ${c}`, fatal: !0 });
      return;
    }
    this.mseController.setDuration(e.duration), this.pendingInitSegment ? ((u = this.mseController) == null || u.appendSegment("video", this.pendingInitSegment), (h = this.mseController) == null || h.appendSegment("audio", this.pendingInitSegment), this.pendingInitSegment = null, this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${s == null ? void 0 : s.codec}`), this.fetchNextChunk()) : (this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${s == null ? void 0 : s.codec}`));
  }
  /**
   * Fetch a single I-frame at `keyframe` for a fast scrub preview, telling the worker to stretch
   * that one decoded sample across `stretchFrames` frame periods so it covers its whole GOP on the
   * MSE timeline. Posted directly (not via fetchNextChunk) so it isn't gated by the scrub guard.
   */
  fetchKeyframePreview(e, t) {
    if (!this.manifest) return;
    this.previewParked = !0, this.nextFetchFrame = e;
    const s = {
      type: "fetchSegment",
      startFrame: e,
      frameCount: 1,
      seqBase: this.seqBase,
      stretchToFrames: t
    };
    this.seqBase += 2, this.worker.postMessage(s);
  }
  fetchNextChunk(e) {
    var u;
    if (this.scrub.isActive || this.previewParked || this.bufferFull || this.fetchPending || !this.manifest) return;
    const t = this.video.currentTime, s = this.editRateNumerator / this.editRateDenominator;
    if (this.nextFetchFrame / s - t >= this.config.maxBufferSeconds) return;
    const r = Math.round(
      this.manifest.duration * this.editRateNumerator / this.editRateDenominator
    );
    if (this.nextFetchFrame >= r) {
      (u = this.mseController) == null || u.endOfStream();
      return;
    }
    const a = e ?? this.nextRampChunk();
    this.fetchPending = !0;
    const o = {
      type: "fetchSegment",
      startFrame: this.nextFetchFrame,
      frameCount: a,
      seqBase: this.seqBase
    };
    this.seqBase += 2, this.nextFetchFrame += a, this.worker.postMessage(o);
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
    this.video.paused && !this.previewParked && this.isSeekServedByBuffer(e) || this.initiateSeek(e, this.config.seekMode);
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
    const s = this.editRateNumerator / this.editRateDenominator, i = Math.round(this.manifest.duration * s);
    return this.nextFetchFrame >= i ? !0 : e + t >= this.nextFetchFrame / s - 0.5;
  }
  onVideoSeeked() {
    this.scrub.onVideoSeeked();
  }
  initiateSeek(e, t) {
    if (!this.manifest) return;
    this.fetchPending = !0, this.startupGating = !0, this.activeSeekMode = t, this.previewParked = !1, this.bufferFull = !1, this.seekTargetFrame = Math.round(
      e * this.editRateNumerator / this.editRateDenominator
    ), this.pendingSeeks++, this.audio.onSeek();
    const s = { type: "seek", targetFrame: this.seekTargetFrame };
    this.worker.postMessage(s);
  }
  onTimeUpdate() {
    var s, i, r;
    if (!this.manifest) return;
    const e = this.video.currentTime;
    this.scrub.isActive || ((s = this.mseController) == null || s.trimBackBuffer(e), (i = this.mseController) == null || i.trimForwardOrphans(e, this.config.maxBufferSeconds + 5), this.bufferFull = !1), (((r = this.mseController) == null ? void 0 : r.getBufferedAhead("video", e)) ?? 0) < this.config.startBufferSeconds && (this.previewParked && !this.video.paused && !this.scrub.isActive ? this.initiateSeek(e, "accurate") : this.fetchNextChunk()), this.emit("timeupdate", { currentTime: e, duration: this.duration }), this.updateTimecode(e);
  }
  /** Buffered-ahead seconds of video at the current playhead (0 if unknown). */
  bufferedAhead() {
    var e;
    return ((e = this.mseController) == null ? void 0 : e.getBufferedAhead("video", this.video.currentTime)) ?? 0;
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
    if (!this.video.paused) {
      this.setBuffering(!1);
      return;
    }
    const e = this.editRateNumerator / this.editRateDenominator, t = Math.round(this.manifest.duration * e), s = this.nextFetchFrame >= t, i = Math.max(0, this.manifest.duration - this.video.currentTime), r = Math.min(this.config.resumeBufferSeconds, Math.max(0, i - 0.05));
    this.bufferedAhead() >= r || s ? (this.startupGating = !1, this.setBuffering(!1), this.video.play().catch(() => {
    })) : (this.setBuffering(!0), this.fetchNextChunk());
  }
  /**
   * The element ran out of buffered data mid-playback ('waiting'). Rather than let it resume the
   * instant a single frame arrives (which produces the stutter), pause it and re-buffer through
   * maybeResumePlayback() so it resumes once cleanly. Ignored while scrubbing / parked on a preview
   * (those manage the element themselves) or when the user has paused.
   */
  onVideoWaiting() {
    !this.playIntent || this.scrub.isActive || this.previewParked || (this.setBuffering(!0), this.startupGating && (this.video.pause(), this.maybeResumePlayback()));
  }
  log(e) {
    this.config.debug && console.log("[mxf.js]", e);
  }
  destroyInternal() {
    var e, t;
    (e = this.worker) == null || e.terminate(), this.worker = null, (t = this.mseController) == null || t.destroy(), this.mseController = null, this.audio.destroy(), this.manifest = null, this.nextFetchFrame = 0, this.fetchPending = !1, this.bufferFull = !1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.playIntent = !1, this.isBuffering = !1, this.startupGating = !1, this.manifestTimecodes = [], this.systemAnchors = [], this.lastTimecodeEditUnit = -1, this.currentTimecodeBundle = null, this.scrub.reset();
  }
  destroy() {
    this.destroyed = !0;
    const e = this.video;
    this.rvfcHandle && typeof e.cancelVideoFrameCallback == "function" && e.cancelVideoFrameCallback(this.rvfcHandle), this.rvfcHandle = 0, this.destroyInternal(), this.removeAllListeners(), this.emit("destroyed", void 0);
  }
}
export {
  O as MxfPlayer,
  V as decodeSmpte12mBcd,
  M as formatTimecode,
  v as frameCountToTimecode,
  $ as timecodeToFrameCount
};
//# sourceMappingURL=mxf.esm.js.map
