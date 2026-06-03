class v {
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
const x = 2, R = 6;
class S extends v {
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
      this.processing.set(e, !1), this.drainQueue(e);
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
    const t = e - R;
    if (!(t <= 0))
      for (const [s, i] of this.sourceBuffers) {
        if (i.buffered.length === 0) continue;
        const r = i.buffered.start(0);
        t > r + 0.5 && this.evict(s, r, t);
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
        const r = s.buffered.length ? s.buffered.start(0) : i.start, n = s.buffered.length ? s.buffered.end(s.buffered.length - 1) : i.end, a = Math.max(i.start, r), o = Math.min(i.end, n);
        o > a ? s.remove(a, o) : (this.processing.set(e, !1), this.drainQueue(e));
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
    const n = this.video.currentTime - 2, a = s.buffered.length ? s.buffered.start(0) : 0;
    s.buffered.length > 0 && n > a + 0.5 ? (i.unshift({ kind: "remove", start: a, end: n }), this.drainQueue(e)) : (this.debug && console.warn(`[mse] ${e} buffer full — pausing fetch until playhead advances`), this.emit("bufferfull", void 0));
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
      const r = s.buffered.start(i), n = s.buffered.end(i);
      if (t >= r - 0.25 && t < n) return n - t;
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
class F {
  constructor(e, t) {
    this.video = e, this.onAudioInfo = t, this.cxt = null, this.startTime = null, this.channelCount = 0, this.active = [0, 1], this.scheduled = [], this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  setEditRate(e, t) {
    this.editRateNumerator = e, this.editRateDenominator = t;
  }
  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(e) {
    this.cxt = new AudioContext({ sampleRate: e });
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
   * Applies to already-buffered audio so the change is near-instant.
   */
  setActiveChannels(e) {
    this.active = [...new Set(e.filter((t) => Number.isInteger(t) && t >= 0))].sort((t, s) => t - s), this.rescheduleActive();
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
   * Schedule a decoded interleaved PCM chunk. Anchors the audio timeline to the <video> playhead on
   * the first chunk after a (re)start/seek so audio locks to the displayed frame.
   */
  schedule(e, t, s, i) {
    if (!this.cxt) return;
    const r = this.cxt;
    this.applyChannelCount(s);
    const n = Math.floor(e.length / s), a = i * this.editRateDenominator / this.editRateNumerator, o = n / t;
    this.startTime === null && (this.startTime = r.currentTime - this.video.currentTime);
    const h = {
      source: null,
      bufStartContextTime: this.startTime + a,
      duration: o,
      samples: e,
      channelCount: s,
      sampleRate: t
    };
    this.scheduleEntry(h) && this.scheduled.push(h);
  }
  /** Drop the playhead anchor so the next chunk re-locks to the (new) playhead. Call on seek. */
  resetAnchor() {
    this.startTime = null;
  }
  /** Stop and clear all scheduled audio (e.g. on seek, so nothing keeps playing at the old offset). */
  flush() {
    for (const e of this.scheduled)
      try {
        e.source && (e.source.onended = null, e.source.stop());
      } catch {
      }
    this.scheduled = [];
  }
  /** Flush and tear down the AudioContext; reset channel state for the next file. */
  destroy() {
    var e;
    this.flush(), (e = this.cxt) == null || e.close().catch(() => {
    }), this.cxt = null, this.startTime = null, this.channelCount = 0;
  }
  /**
   * Mix an interleaved buffer's currently-active channels to stereo and start it at the right point
   * on the AudioContext clock. Audio whose window lies entirely before the playhead is dropped (this
   * skips the keyframe→target frames an accurate seek decodes for the picture but which precede the
   * displayed frame); a chunk straddling the playhead starts partway in. Returns false if nothing was
   * scheduled. Mixing explicitly is more reliable than Web Audio's implicit down-mix (undefined for
   * >6/non-standard channel counts).
   */
  scheduleEntry(e) {
    const t = this.cxt, s = t.currentTime, i = s - e.bufStartContextTime;
    if (i >= e.duration - 1e-3) return !1;
    const { samples: r, channelCount: n, sampleRate: a } = e, o = Math.floor(r.length / n), h = this.active.filter((u) => u < n), l = [], m = [];
    h.forEach((u, d) => (d % 2 === 0 ? l : m).push(u)), h.length === 1 && (m.length = 0, m.push(h[0]));
    const g = t.createBuffer(2, o, a), k = (u, d) => {
      if (d.length === 0) return;
      const C = 1 / d.length;
      for (let p = 0; p < o; p++) {
        let b = 0;
        const M = p * n;
        for (const w of d) b += r[M + w];
        u[p] = b * C;
      }
    };
    k(g.getChannelData(0), l), k(g.getChannelData(1), m);
    const c = t.createBufferSource();
    return c.buffer = g, c.connect(t.destination), i <= 0 ? c.start(e.bufStartContextTime) : c.start(s, i), c.onended = () => {
      const u = this.scheduled.indexOf(e);
      u >= 0 && this.scheduled.splice(u, 1);
    }, e.source = c, !0;
  }
  /**
   * Re-mix and reschedule all still-playing / future audio with the current channel selection, so a
   * change takes effect (near-)immediately instead of only on the next decoded chunk.
   */
  rescheduleActive() {
    if (!this.cxt) return;
    const e = [];
    for (const t of this.scheduled) {
      try {
        t.source && (t.source.onended = null, t.source.stop());
      } catch {
      }
      t.source = null, this.scheduleEntry(t) && e.push(t);
    }
    this.scheduled = e;
  }
}
class T {
  constructor(e, t, s) {
    this.video = e, this.requestPreview = t, this.settle = s, this.active = !1, this.cycle = 0, this.latestFrame = null, this.seq = 0, this.watchdog = null, this.wasPlaying = !1, this.suppressSeeking = !1, this.hasStream = !1, this.duration = 0, this.editRateNumerator = 25, this.editRateDenominator = 1;
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
    this.suppressSeeking = t !== this.video.currentTime, this.video.currentTime = t, this.settle(t), this.wasPlaying && this.video.play().catch(() => {
    });
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
const B = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: "auto",
  seekMode: "accurate",
  debug: !1
};
class y extends v {
  constructor(e, t = {}) {
    super(), this.worker = null, this.mseController = null, this.manifest = null, this.nextFetchFrame = 0, this.framesPerChunk = 50, this.fetchPending = !1, this.bufferFull = !1, this.editRateNumerator = 25, this.editRateDenominator = 1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.video = e, this.config = { ...B, ...t }, this.audio = new F(this.video, (s) => this.emit("audio-info", s)), this.scrub = new T(
      this.video,
      (s, i) => {
        var r;
        return (r = this.worker) == null ? void 0 : r.postMessage({ type: "scrubPreview", targetFrame: s, seq: i });
      },
      (s) => this.initiateSeek(s, "accurate")
    ), this.video.addEventListener("seeking", () => this.onVideoSeeking()), this.video.addEventListener("seeked", () => this.onVideoSeeked()), this.video.addEventListener("timeupdate", () => this.onTimeUpdate());
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
   * Which seeking strategy the loaded file supports, or null before the manifest arrives:
   * 'cbg' (constant-byte-count math), 'vbe' (per-frame index entries), or 'none' (growing/live —
   * approximate offset-percentage seeking). Useful for tailoring UI (e.g. exact vs approximate seek).
   */
  get indexMode() {
    var e;
    return ((e = this.manifest) == null ? void 0 : e.indexMode) ?? null;
  }
  play() {
    this.previewParked && this.manifest && this.initiateSeek(this.video.currentTime, "accurate"), this.video.play().catch(() => {
    }), this.audio.resume();
  }
  pause() {
    this.video.pause(), this.audio.suspend();
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
    (e = this.worker) == null || e.postMessage({ type: "cancelPrefetch" }), this.fetchPending = !1, this.scrub.beginScrub();
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
    });
  }
  createWorker() {
    const e = new URL("./demux-worker.js", import.meta.url);
    return new Worker(e);
  }
  async onWorkerMessage(e) {
    var t, s, i, r;
    switch (e.type) {
      case "manifest":
        await this.onManifest(e);
        break;
      case "initSegment":
        (t = this.mseController) != null && t.hasVideoBuffer() || (s = this.mseController) != null && s.hasAudioBuffer() ? (this.mseController.appendSegment("video", e.data), this.mseController.appendSegment("audio", e.data), this.fetchNextChunk()) : this.pendingInitSegment = e.data;
        break;
      case "videoSegment":
        (i = this.mseController) == null || i.appendSegment("video", e.data), e.nextFrame !== void 0 && !this.scrub.isActive && !this.previewParked && (this.nextFetchFrame = e.nextFrame);
        break;
      case "audioSegment":
        (r = this.mseController) == null || r.appendSegment("audio", e.data);
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
        const a = Math.min(
          this.framesPerChunk,
          Math.max(1, this.seekTargetFrame - n + 3)
        );
        this.fetchNextChunk(a);
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
    var o, h;
    const t = e.pictureDescriptor, s = e.soundDescriptor;
    this.editRateNumerator = e.editRateNumerator, this.editRateDenominator = e.editRateDenominator, this.audio.setEditRate(e.editRateNumerator, e.editRateDenominator), this.scrub.setStream(e.duration, e.editRateNumerator, e.editRateDenominator);
    const i = e.editRateNumerator / e.editRateDenominator;
    this.framesPerChunk = Math.ceil(i * x), this.manifest = {
      duration: e.duration,
      editRateNumerator: e.editRateNumerator,
      editRateDenominator: e.editRateDenominator,
      tracks: e.tracks,
      pictureDescriptor: t,
      soundDescriptor: s,
      indexMode: e.indexMode,
      longGop: e.longGop
    };
    const r = e.resolvedVideoCodec ?? (t == null ? void 0 : t.codec) ?? "unknown", n = t && e.videoCodecSupported ? S.getMimeType("video", r) : null;
    let a = s ? S.getMimeType("audio", s.codec) : null;
    (s == null ? void 0 : s.codec) === "pcm" && (this.config.pcmAudioMode === "webaudio" || !a) && (a = null, this.audio.createContext(s.sampleRate)), this.audio.applyChannelCount(e.audioChannelCount);
    try {
      await this.mseController.open(n, a);
    } catch (l) {
      this.emit("error", { message: `MSE open failed: ${l}`, fatal: !0 });
      return;
    }
    this.mseController.setDuration(e.duration), this.pendingInitSegment ? ((o = this.mseController) == null || o.appendSegment("video", this.pendingInitSegment), (h = this.mseController) == null || h.appendSegment("audio", this.pendingInitSegment), this.pendingInitSegment = null, this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${s == null ? void 0 : s.codec}`), this.fetchNextChunk()) : (this.emit("manifest", this.manifest), this.log(`Manifest: ${e.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${s == null ? void 0 : s.codec}`));
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
  fetchNextChunk(e = this.framesPerChunk) {
    var a;
    if (this.scrub.isActive || this.previewParked || this.bufferFull || this.fetchPending || !this.manifest) return;
    const t = this.video.currentTime, s = this.editRateNumerator / this.editRateDenominator;
    if (this.nextFetchFrame / s - t >= this.config.maxBufferSeconds) return;
    const r = Math.round(
      this.manifest.duration * this.editRateNumerator / this.editRateDenominator
    );
    if (this.nextFetchFrame >= r) {
      (a = this.mseController) == null || a.endOfStream();
      return;
    }
    this.fetchPending = !0;
    const n = {
      type: "fetchSegment",
      startFrame: this.nextFetchFrame,
      frameCount: e,
      seqBase: this.seqBase
    };
    this.seqBase += 2, this.nextFetchFrame += e, this.worker.postMessage(n);
  }
  onVideoSeeking() {
    if (!this.manifest || this.scrub.consumeSuppressedSeeking()) return;
    const e = this.video.currentTime;
    if (this.emit("seeking", { targetTime: e }), this.scrub.isActive) {
      this.scrub.scrubTo(e);
      return;
    }
    this.initiateSeek(e, this.config.seekMode);
  }
  onVideoSeeked() {
    this.scrub.onVideoSeeked();
  }
  initiateSeek(e, t) {
    if (!this.manifest) return;
    this.fetchPending = !0, this.activeSeekMode = t, this.previewParked = !1, this.bufferFull = !1, this.seekTargetFrame = Math.round(
      e * this.editRateNumerator / this.editRateDenominator
    ), this.pendingSeeks++, this.audio.flush(), this.audio.resetAnchor();
    const s = { type: "seek", targetFrame: this.seekTargetFrame };
    this.worker.postMessage(s);
  }
  onTimeUpdate() {
    var s, i;
    if (!this.manifest) return;
    const e = this.video.currentTime;
    this.scrub.isActive || ((s = this.mseController) == null || s.trimBackBuffer(e), this.bufferFull = !1);
    const t = ((i = this.mseController) == null ? void 0 : i.getBufferedAhead("video", e)) ?? 0;
    t < this.config.startBufferSeconds && (this.previewParked && !this.video.paused && !this.scrub.isActive ? this.initiateSeek(e, "accurate") : this.fetchNextChunk()), this.emit("buffering", { bufferedSeconds: t }), this.emit("timeupdate", { currentTime: e, duration: this.duration });
  }
  log(e) {
    this.config.debug && console.log("[mxf.js]", e);
  }
  destroyInternal() {
    var e, t;
    (e = this.worker) == null || e.terminate(), this.worker = null, (t = this.mseController) == null || t.destroy(), this.mseController = null, this.audio.destroy(), this.manifest = null, this.nextFetchFrame = 0, this.fetchPending = !1, this.bufferFull = !1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.scrub.reset();
  }
  destroy() {
    this.destroyInternal(), this.removeAllListeners(), this.emit("destroyed", void 0);
  }
}
export {
  y as MxfPlayer
};
//# sourceMappingURL=mxf.esm.js.map
