class B {
  constructor() {
    this.listeners = /* @__PURE__ */ new Map();
  }
  on(g, t) {
    const e = String(g);
    return this.listeners.has(e) || this.listeners.set(e, /* @__PURE__ */ new Set()), this.listeners.get(e).add(t), this;
  }
  off(g, t) {
    var e;
    return (e = this.listeners.get(String(g))) == null || e.delete(t), this;
  }
  once(g, t) {
    const e = (I) => {
      t(I), this.off(g, e);
    };
    return this.on(g, e);
  }
  emit(g, t) {
    var e;
    (e = this.listeners.get(String(g))) == null || e.forEach((I) => {
      try {
        I(t);
      } catch {
      }
    });
  }
  removeAllListeners() {
    this.listeners.clear();
  }
}
const y = 2, S = 6;
class b extends B {
  constructor(g, t = !1) {
    super(), this.mediaSource = null, this.objectURL = null, this.sourceBuffers = /* @__PURE__ */ new Map(), this.queues = /* @__PURE__ */ new Map(), this.processing = /* @__PURE__ */ new Map(), this.video = g, this.debug = t;
  }
  open(g, t) {
    return new Promise((e, I) => {
      this.mediaSource = new MediaSource(), this.objectURL = URL.createObjectURL(this.mediaSource), this.video.src = this.objectURL, this.mediaSource.addEventListener("sourceopen", () => {
        try {
          g && MediaSource.isTypeSupported(g) && this.addSourceBuffer("video", g), t && MediaSource.isTypeSupported(t) && this.addSourceBuffer("audio", t), e();
        } catch (c) {
          I(c);
        }
      }, { once: !0 }), this.mediaSource.addEventListener("error", () => I(new Error("MediaSource error")), { once: !0 });
    });
  }
  addSourceBuffer(g, t) {
    this.debug && console.log(`[mse] addSourceBuffer ${g} "${t}"`);
    const e = this.mediaSource.addSourceBuffer(t);
    this.sourceBuffers.set(g, e), this.queues.set(g, []), this.processing.set(g, !1), e.addEventListener("updateend", () => {
      this.processing.set(g, !1), this.drainQueue(g);
    }), e.addEventListener("error", () => {
      const I = `SourceBuffer error on ${g} track — codec may be unsupported or data is malformed`;
      console.error(`[mxf.js] ${I}`), this.emit("error", { track: g, message: I });
    });
  }
  appendSegment(g, t) {
    const e = this.queues.get(g);
    e && (e.push({ kind: "append", data: t }), this.drainQueue(g));
  }
  /** Queue a removal of buffered media in [start, end) for a track (used to cap buffer growth). */
  evict(g, t, e) {
    const I = this.queues.get(g);
    !I || e <= t || (I.push({ kind: "remove", start: t, end: e }), this.drainQueue(g));
  }
  /**
   * Evict already-played media older than `BACK_BUFFER_SECONDS` behind `currentTime` on every track,
   * keeping the resident buffer bounded. Called as playback advances. No-op if there's nothing old
   * enough to remove.
   */
  trimBackBuffer(g) {
    const t = g - S;
    if (!(t <= 0))
      for (const [e, I] of this.sourceBuffers) {
        if (I.buffered.length === 0) continue;
        const c = I.buffered.start(0);
        t > c + 0.5 && this.evict(e, c, t);
      }
  }
  drainQueue(g) {
    if (this.processing.get(g)) return;
    const t = this.queues.get(g), e = this.sourceBuffers.get(g);
    if (!t || !e || t.length === 0 || e.updating) return;
    const I = t[0];
    this.processing.set(g, !0);
    try {
      if (I.kind === "append")
        t.shift(), e.appendBuffer(I.data);
      else {
        t.shift();
        const c = e.buffered.length ? e.buffered.start(0) : I.start, l = e.buffered.length ? e.buffered.end(e.buffered.length - 1) : I.end, i = Math.max(I.start, c), Z = Math.min(I.end, l);
        Z > i ? e.remove(i, Z) : (this.processing.set(g, !1), this.drainQueue(g));
      }
    } catch (c) {
      this.processing.set(g, !1), I.kind === "append" && (c == null ? void 0 : c.name) === "QuotaExceededError" ? this.handleQuota(g, I.data) : console.error(`appendBuffer error (${g}):`, c);
    }
  }
  /**
   * The SourceBuffer is full. Free space by evicting media behind the playhead and retry the append.
   * If there's nothing behind to evict (the forward buffer alone is over quota — common for
   * high-bitrate all-intra like AVC-Intra), the segment can't be appended now: re-queue it at the
   * front and tell the player to stop fetching until the playhead advances and frees room.
   */
  handleQuota(g, t) {
    const e = this.sourceBuffers.get(g), I = this.queues.get(g);
    if (!e || !I) return;
    I.unshift({ kind: "append", data: t });
    const l = this.video.currentTime - 2, i = e.buffered.length ? e.buffered.start(0) : 0;
    e.buffered.length > 0 && l > i + 0.5 ? (I.unshift({ kind: "remove", start: i, end: l }), this.drainQueue(g)) : (this.debug && console.warn(`[mse] ${g} buffer full — pausing fetch until playhead advances`), this.emit("bufferfull", void 0));
  }
  setDuration(g) {
    if (this.mediaSource && this.mediaSource.readyState === "open")
      try {
        this.mediaSource.duration = g;
      } catch {
      }
  }
  endOfStream() {
    if (this.mediaSource && this.mediaSource.readyState === "open") {
      const g = () => {
        if ([...this.sourceBuffers.values()].some((e) => e.updating))
          setTimeout(g, 50);
        else
          try {
            this.mediaSource.endOfStream();
          } catch {
          }
      };
      g();
    }
  }
  /** Returns the current buffered end time in seconds for a given track */
  getBufferedEnd(g) {
    const t = this.sourceBuffers.get(g);
    return !t || t.buffered.length === 0 ? 0 : t.buffered.end(t.buffered.length - 1);
  }
  /**
   * Seconds of media buffered contiguously starting at `time`. Unlike getBufferedEnd this is
   * range-aware: if `time` is not inside any buffered range it returns 0 (data is needed here
   * now), and if it is, it returns the end of *that* range — not the end of some unrelated
   * later range. This is what fetch scheduling must use, otherwise a seek into an unbuffered
   * gap while a far-ahead range exists looks "buffered" and never fetches → permanent stall.
   */
  getBufferedAhead(g, t) {
    const e = this.sourceBuffers.get(g);
    if (!e || e.buffered.length === 0) return 0;
    for (let I = 0; I < e.buffered.length; I++) {
      const c = e.buffered.start(I), l = e.buffered.end(I);
      if (t >= c - 0.25 && t < l) return l - t;
    }
    return 0;
  }
  /** Returns the current buffered start time in seconds for a given track */
  getBufferedStart(g) {
    const t = this.sourceBuffers.get(g);
    return !t || t.buffered.length === 0 ? 0 : t.buffered.start(0);
  }
  hasVideoBuffer() {
    return this.sourceBuffers.has("video");
  }
  hasAudioBuffer() {
    return this.sourceBuffers.has("audio");
  }
  static isVideoTypeSupported(g) {
    return g === "h264" ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"') : MediaSource.isTypeSupported('video/mp4; codecs="mp4v.20.2"');
  }
  static isAudioTypeSupported(g) {
    return g === "aac" ? MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') : MediaSource.isTypeSupported('audio/mp4; codecs="ipcm"') || MediaSource.isTypeSupported('audio/mp4; codecs="sowt"');
  }
  static getMimeType(g, t) {
    if (g === "video") {
      if (t === "h264" || t.startsWith("avc1."))
        return `video/mp4; codecs="${t.startsWith("avc1.") ? t : "avc1.640033"}"`;
      if (t === "mpeg2") return 'video/mp4; codecs="mp4v.20.2"';
    }
    if (g === "audio") {
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
class R {
  constructor(g, t) {
    this.video = g, this.onAudioInfo = t, this.cxt = null, this.startTime = null, this.channelCount = 0, this.active = [0, 1], this.scheduled = [], this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  setEditRate(g, t) {
    this.editRateNumerator = g, this.editRateDenominator = t;
  }
  /** Create the AudioContext (PCM that MSE can't play is routed here). Pinned to the source rate. */
  createContext(g) {
    this.cxt = new AudioContext({ sampleRate: g });
  }
  hasContext() {
    return this.cxt !== null;
  }
  resume() {
    var g;
    (g = this.cxt) == null || g.resume().catch(() => {
    });
  }
  suspend() {
    var g;
    (g = this.cxt) == null || g.suspend().catch(() => {
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
  setActiveChannels(g) {
    this.active = [...new Set(g.filter((t) => Number.isInteger(t) && t >= 0))].sort((t, e) => t - e), this.rescheduleActive();
  }
  /**
   * Record a (descriptor- or stream-derived) channel count, clamp the active selection to it, and
   * announce it. Used both at manifest time (before audio plays, so the UI can build a selector) and
   * when a decoded chunk's count differs from what we last announced.
   */
  applyChannelCount(g) {
    g <= 0 || g === this.channelCount || (this.channelCount = g, this.active = this.active.filter((t) => t < g), this.active.length === 0 && (this.active = g >= 2 ? [0, 1] : [0]), this.onAudioInfo({ channelCount: g, activeChannels: this.active.slice() }));
  }
  /**
   * Schedule a decoded interleaved PCM chunk. Anchors the audio timeline to the <video> playhead on
   * the first chunk after a (re)start/seek so audio locks to the displayed frame.
   */
  schedule(g, t, e, I) {
    if (!this.cxt) return;
    const c = this.cxt;
    this.applyChannelCount(e);
    const l = Math.floor(g.length / e), i = I * this.editRateDenominator / this.editRateNumerator, Z = l / t;
    this.startTime === null && (this.startTime = c.currentTime - this.video.currentTime);
    const s = {
      source: null,
      bufStartContextTime: this.startTime + i,
      duration: Z,
      samples: g,
      channelCount: e,
      sampleRate: t
    };
    this.scheduleEntry(s) && this.scheduled.push(s);
  }
  /** Drop the playhead anchor so the next chunk re-locks to the (new) playhead. Call on seek. */
  resetAnchor() {
    this.startTime = null;
  }
  /** Stop and clear all scheduled audio (e.g. on seek, so nothing keeps playing at the old offset). */
  flush() {
    for (const g of this.scheduled)
      try {
        g.source && (g.source.onended = null, g.source.stop());
      } catch {
      }
    this.scheduled = [];
  }
  /** Flush and tear down the AudioContext; reset channel state for the next file. */
  destroy() {
    var g;
    this.flush(), (g = this.cxt) == null || g.close().catch(() => {
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
  scheduleEntry(g) {
    const t = this.cxt, e = t.currentTime, I = e - g.bufStartContextTime;
    if (I >= g.duration - 1e-3) return !1;
    const { samples: c, channelCount: l, sampleRate: i } = g, Z = Math.floor(c.length / l), s = this.active.filter((d) => d < l), n = [], o = [];
    s.forEach((d, a) => (a % 2 === 0 ? n : o).push(d)), s.length === 1 && (o.length = 0, o.push(s[0]));
    const G = t.createBuffer(2, Z, i), W = (d, a) => {
      if (a.length === 0) return;
      const A = 1 / a.length;
      for (let m = 0; m < Z; m++) {
        let u = 0;
        const r = m * l;
        for (const V of a) u += c[r + V];
        d[m] = u * A;
      }
    };
    W(G.getChannelData(0), n), W(G.getChannelData(1), o);
    const C = t.createBufferSource();
    return C.buffer = G, C.connect(t.destination), I <= 0 ? C.start(g.bufStartContextTime) : C.start(e, I), C.onended = () => {
      const d = this.scheduled.indexOf(g);
      d >= 0 && this.scheduled.splice(d, 1);
    }, g.source = C, !0;
  }
  /**
   * Re-mix and reschedule all still-playing / future audio with the current channel selection, so a
   * change takes effect (near-)immediately instead of only on the next decoded chunk.
   */
  rescheduleActive() {
    if (!this.cxt) return;
    const g = [];
    for (const t of this.scheduled) {
      try {
        t.source && (t.source.onended = null, t.source.stop());
      } catch {
      }
      t.source = null, this.scheduleEntry(t) && g.push(t);
    }
    this.scheduled = g;
  }
}
class X {
  constructor(g, t, e) {
    this.video = g, this.requestPreview = t, this.settle = e, this.active = !1, this.cycle = 0, this.latestFrame = null, this.seq = 0, this.watchdog = null, this.wasPlaying = !1, this.suppressSeeking = !1, this.hasStream = !1, this.duration = 0, this.editRateNumerator = 25, this.editRateDenominator = 1;
  }
  /** True while a scrub is in progress (beginScrub→endScrub). */
  get isActive() {
    return this.active;
  }
  /** Record stream parameters once the manifest arrives (enables scrubTo/endScrub). */
  setStream(g, t, e) {
    this.hasStream = !0, this.duration = g, this.editRateNumerator = t, this.editRateDenominator = e;
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
  scrubTo(g) {
    if (!this.hasStream || !this.active) return;
    const t = Math.max(0, Math.min(g, this.duration));
    this.latestFrame = Math.round(t * this.editRateNumerator / this.editRateDenominator), this.pump();
  }
  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position). Moves
   * the playhead there, suppresses the resulting self-induced 'seeking', drives the accurate settle,
   * and resumes playback if it was running. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(g) {
    if (!this.active || (this.active = !1, this.latestFrame = null, this.cycle = 0, this.clearWatchdog(), !this.hasStream)) return;
    const t = Math.max(0, Math.min(g ?? this.video.currentTime, this.duration));
    this.suppressSeeking = t !== this.video.currentTime, this.video.currentTime = t, this.settle(t), this.wasPlaying && this.video.play().catch(() => {
    });
  }
  /**
   * A scrub preview's segment has been posted (and queued for append). `renderEditUnit` is the
   * keyframe the preview represents (from the worker) — seek THERE, into the contiguous run just
   * appended, not to the mid-GOP dragged target (which may be outside the short preview run). The
   * contiguous run is what lets a paused <video> paint. Wait for 'seeked' before the next cycle.
   */
  onPreviewDone(g) {
    if (!this.active || this.cycle === 0 || !this.hasStream) {
      this.cycle = 0;
      return;
    }
    const t = Math.max(0, Math.min(g * this.editRateDenominator / this.editRateNumerator, this.duration));
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
    const g = this.latestFrame;
    this.latestFrame = null, this.cycle = 1, this.seq++, this.requestPreview(g, this.seq);
  }
  /** Seek completed (or watchdog) — advance to the freshest dragged position. */
  completeRender() {
    this.clearWatchdog(), this.cycle = 0, this.pump();
  }
  clearWatchdog() {
    this.watchdog !== null && (clearTimeout(this.watchdog), this.watchdog = null);
  }
}
const Y = {
  startBufferSeconds: 10,
  maxBufferSeconds: 30,
  pcmAudioMode: "auto",
  seekMode: "accurate",
  debug: !1
};
class p extends B {
  constructor(g, t = {}) {
    super(), this.worker = null, this.mseController = null, this.manifest = null, this.nextFetchFrame = 0, this.framesPerChunk = 50, this.fetchPending = !1, this.bufferFull = !1, this.editRateNumerator = 25, this.editRateDenominator = 1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.video = g, this.config = { ...Y, ...t }, this.audio = new R(this.video, (e) => this.emit("audio-info", e)), this.scrub = new X(
      this.video,
      (e, I) => {
        var c;
        return (c = this.worker) == null ? void 0 : c.postMessage({ type: "scrubPreview", targetFrame: e, seq: I });
      },
      (e) => this.initiateSeek(e, "accurate")
    ), this.video.addEventListener("seeking", () => this.onVideoSeeking()), this.video.addEventListener("seeked", () => this.onVideoSeeked()), this.video.addEventListener("timeupdate", () => this.onTimeUpdate());
  }
  get currentTime() {
    return this.video.currentTime;
  }
  get duration() {
    var g;
    return ((g = this.manifest) == null ? void 0 : g.duration) ?? 0;
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
    var g;
    return ((g = this.manifest) == null ? void 0 : g.indexMode) ?? null;
  }
  play() {
    this.previewParked && this.manifest && this.initiateSeek(this.video.currentTime, "accurate"), this.video.play().catch(() => {
    }), this.audio.resume();
  }
  pause() {
    this.video.pause(), this.audio.suspend();
  }
  /** Seek to a time in seconds. The <video> 'seeking' event drives the worker fetch. */
  seek(g) {
    if (!this.manifest) return;
    const t = Math.max(0, Math.min(g, this.manifest.duration));
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
    var g;
    (g = this.worker) == null || g.postMessage({ type: "cancelPrefetch" }), this.fetchPending = !1, this.scrub.beginScrub();
  }
  /**
   * Report a live drag position (seconds) during scrubbing. Records it as the newest target and
   * kicks the single-flight preview pump; does NOT touch video.currentTime (see beginScrub()).
   */
  scrubTo(g) {
    this.scrub.scrubTo(g);
  }
  /**
   * Leave scrub mode and settle on an accurate frame at `timeSeconds` (the released position):
   * decodes the preceding keyframe up to the exact target so the final picture is precise, then
   * resumes normal forward fetching (and playback, if it was running). Call on the slider's
   * `change` event. If `timeSeconds` is omitted the current playhead is used.
   */
  endScrub(g) {
    this.scrub.endScrub(g);
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
  setAudioChannels(g) {
    this.audio.setActiveChannels(g);
  }
  loadUrl(g) {
    this.setup();
    const t = { type: "initUrl", url: g, debug: this.config.debug, videoMode: "mse" };
    this.worker.postMessage(t);
  }
  loadFile(g) {
    this.setup();
    const t = { type: "initFile", file: g, debug: this.config.debug, videoMode: "mse" };
    this.worker.postMessage(t);
  }
  setup() {
    this.destroyInternal(), this.worker = this.createWorker(), this.worker.addEventListener("message", (g) => this.onWorkerMessage(g.data)), this.worker.addEventListener("error", (g) => {
      var e;
      const t = [
        g.message,
        g.filename && `${g.filename}:${g.lineno ?? "?"}:${g.colno ?? "?"}`,
        (e = g.error) == null ? void 0 : e.stack
      ].filter(Boolean).join(" — ");
      console.error("[mxf.js] worker error:", g, g.error), this.emit("error", {
        message: t || "Worker failed to load — reload the page (the dev server may have restarted)",
        fatal: !0
      });
    }), this.worker.addEventListener("messageerror", (g) => {
      this.emit("error", { message: `Worker message error: ${String(g)}`, fatal: !0 });
    }), this.mseController = new b(this.video, !!this.config.debug), this.mseController.on("error", ({ track: g, message: t }) => {
      this.emit("error", { message: `MSE ${g}: ${t}`, fatal: !1 });
    }), this.mseController.on("bufferfull", () => {
      this.bufferFull = !0, this.fetchPending = !1;
    });
  }
  createWorker() {
    const g = new URL("data:video/mp2t;base64,aW1wb3J0IHsgSHR0cExvYWRlciB9IGZyb20gJy4uL2xvYWRlci9odHRwLWxvYWRlci5qcyc7CmltcG9ydCB7IEZpbGVMb2FkZXIgfSBmcm9tICcuLi9sb2FkZXIvZmlsZS1sb2FkZXIuanMnOwppbXBvcnQgeyBJTG9hZGVyIH0gZnJvbSAnLi4vbG9hZGVyL2xvYWRlci5qcyc7CmltcG9ydCB7IE14ZkZpbGUgfSBmcm9tICcuLi9teGYtZmlsZS5qcyc7CmltcG9ydCB7IEVzc2VuY2VFeHRyYWN0b3IgfSBmcm9tICcuLi9lc3NlbmNlL2Vzc2VuY2UtZXh0cmFjdG9yLmpzJzsKaW1wb3J0IHsgTXA0RnJhZ21lbnRlciB9IGZyb20gJy4uL3JlbXV4ZXIvbXA0LWZyYWdtZW50ZXIuanMnOwppbXBvcnQgeyByZXNvbHZlRnJhbWVPZmZzZXQsIGdvcExlbmd0aEZyb21LZXlmcmFtZSB9IGZyb20gJy4uL3BhcnNlci9pbmRleC10YWJsZS5qcyc7CmltcG9ydCB7IGlzQW5uZXhCLCBhbm5leEJ0b0FWQ0MsIGV4dHJhY3RTUFNQUFMsIGJ1aWxkQVZDRGVjb2RlckNvbmZpZ1JlY29yZCB9IGZyb20gJy4uL2Vzc2VuY2UvYXZjLXRvb2xzLmpzJzsKaW1wb3J0IHsgZGVjb2RlUGNtRWxlbWVudHMgfSBmcm9tICcuLi9hdWRpby9wY20uanMnOwppbXBvcnQgeyBXb3JrZXJDb21tYW5kLCBXb3JrZXJFdmVudCB9IGZyb20gJy4vd29ya2VyLW1lc3NhZ2VzLmpzJzsKaW1wb3J0IHR5cGUgeyBFc3NlbmNlRnJhbWUgfSBmcm9tICcuLi9lc3NlbmNlL2Vzc2VuY2UtZXh0cmFjdG9yLmpzJzsKaW1wb3J0IHsgU2NydWJTZWdtZW50Q2FjaGUgfSBmcm9tICcuL3NjcnViLXNlZ21lbnQtY2FjaGUuanMnOwppbXBvcnQgeyBGZXRjaFF1ZXVlIH0gZnJvbSAnLi9mZXRjaC1xdWV1ZS5qcyc7CmltcG9ydCB7IE1wZWcyUGlwZWxpbmUgfSBmcm9tICcuL21wZWcyLXBpcGVsaW5lLmpzJzsKaW1wb3J0IHsKICBTQ1JVQl9QUkVWSUVXX0xPT0tBSEVBRF9TRUNPTkRTLAogIFNDUlVCX1BSRVZJRVdfTUlOX0xPT0tBSEVBRF9GUkFNRVMsCn0gZnJvbSAnLi4vY29yZS9jb25zdGFudHMuanMnOwoKaW50ZXJmYWNlIFdvcmtlclNjb3BlIHsKICBwb3N0TWVzc2FnZShtZXNzYWdlOiB1bmtub3duLCB0cmFuc2Zlcj86IFRyYW5zZmVyYWJsZVtdKTogdm9pZDsKICBhZGRFdmVudExpc3RlbmVyKHR5cGU6ICdtZXNzYWdlJywgbGlzdGVuZXI6IChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB2b2lkKTogdm9pZDsKfQpkZWNsYXJlIGNvbnN0IHNlbGY6IFdvcmtlclNjb3BlOwoKbGV0IGxvYWRlcjogSUxvYWRlciB8IG51bGwgPSBudWxsOwpsZXQgbXhmRmlsZTogTXhmRmlsZSB8IG51bGwgPSBudWxsOwpsZXQgZnJhZ21lbnRlcjogTXA0RnJhZ21lbnRlciB8IG51bGwgPSBudWxsOwpsZXQgdmlkZW9Nb2RlOiAnd2ViY29kZWNzJyB8ICdtc2UnID0gJ21zZSc7CmxldCBzdG9yZWRFZGl0UmF0ZU51bWVyYXRvciA9IDI1OwpsZXQgc3RvcmVkRWRpdFJhdGVEZW5vbWluYXRvciA9IDE7Ci8vIEdhdGVzIHRoZSB3b3JrZXIncyBpbmZvcm1hdGlvbmFsL3RyYWNlIGxvZ3MgKHNldCBmcm9tIGNtZC5kZWJ1ZyBpbiBoYW5kbGVJbml0KS4gRXJyb3IgbG9ncwovLyBhcmUgdW5jb25kaXRpb25hbDsgdGhlc2UgYXJlIHByb2dyZXNzL2RpYWdub3N0aWMgbGluZXMgdGhhdCB3b3VsZCBvdGhlcndpc2Ugc3BhbSBldmVyeSBjb25zdW1lci4KbGV0IHdvcmtlckRlYnVnID0gZmFsc2U7CgovLyBNUEVHLTIg4oaSIEguMjY0IHRyYW5zY29kZSBwaXBlbGluZSAobnVsbCB3aGVuIHNvdXJjZSBpcyBub3QgTVBFRy0yKS4gT3ducyB0aGUgcGVyc2lzdGVudAovLyBkZWNvZGVyICsgZW5jb2RlciwgdGhlIGRpc3BsYXktb3JkZXIgZWRpdC11bml0IGNvdW50ZXIsIGFuZCB0aGUgaGVsZC1hbmNob3IgZGVjb2RlIGxvb3AuCmxldCBtcGVnMlBpcGVsaW5lOiBNcGVnMlBpcGVsaW5lIHwgbnVsbCA9IG51bGw7CgovLyBTZXJpYWxpemVzIGZldGNoZXMgKG9uZSBhdCBhIHRpbWUpIGFuZCBsZXRzIGEgc2VlayBkaXNjYXJkIHN1cGVyc2VkZWQgd29yayDigJQgc2VlIEZldGNoUXVldWUuCi8vIHJ1biBleGVjdXRlcyBvbmUgam9iIGJ5IGRlbGVnYXRpbmcgdG8gaGFuZGxlRmV0Y2hTZWdtZW50IChob2lzdGVkLCBzbyByZWZlcmVuY2luZyBpdCBoZXJlIGlzIGZpbmUpLgpjb25zdCBmZXRjaFEgPSBuZXcgRmV0Y2hRdWV1ZSgoam9iKSA9PgogIGhhbmRsZUZldGNoU2VnbWVudChqb2Iuc3RhcnRGcmFtZSwgam9iLmZyYW1lQ291bnQsIGpvYi5zZXFCYXNlLCBqb2IuZ2VuLCBqb2Iuc3RyZXRjaFRvRnJhbWVzLCBqb2IucHJldmlld1NlcSksCik7Ci8vIHNlcUJhc2UgcG9vbCBmb3IgaW50ZXJuYWxseS1zY2hlZHVsZWQgc2NydWItcHJldmlldyBkZWNvZGVzIChrZXB0IGFwYXJ0IGZyb20gdGhlIHBsYXllcidzIHNlcUJhc2UpLgpsZXQgc2NydWJTZXFCYXNlID0gMV8wMDBfMDAwOwoKLy8gU2NydWItcHJldmlldyBjYWNoZSAoR09QLWhlYWQga2V5ZnJhbWUgZWRpdCB1bml0IOKGkiBlbmNvZGVkIGZNUDQgdmlkZW8gc2VnbWVudCk7IHNlZQovLyBTY3J1YlNlZ21lbnRDYWNoZSBmb3Igd2h5IHRoaXMgaXMgd2hhdCBtYWtlcyBNUEVHLTIgc2NydWJiaW5nIHVzYWJsZS4gQ2xlYXJlZCBvbiBlYWNoIGZpbGUgbG9hZC4KY29uc3Qgc2NydWJTZWdtZW50Q2FjaGUgPSBuZXcgU2NydWJTZWdtZW50Q2FjaGUoKTsKCmZ1bmN0aW9uIHBvc3QoZXZlbnQ6IFdvcmtlckV2ZW50LCB0cmFuc2ZlcmFibGVzOiBUcmFuc2ZlcmFibGVbXSA9IFtdKTogdm9pZCB7CiAgc2VsZi5wb3N0TWVzc2FnZShldmVudCwgdHJhbnNmZXJhYmxlcyk7Cn0KCmZ1bmN0aW9uIHBvc3RFcnJvcihtZXNzYWdlOiBzdHJpbmcsIGZhdGFsID0gZmFsc2UpOiB2b2lkIHsKICBwb3N0KHsgdHlwZTogJ2Vycm9yJywgbWVzc2FnZSwgZmF0YWwgfSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUluaXQobG9hZGVyXzogSUxvYWRlciwgZGVidWcgPSBmYWxzZSk6IFByb21pc2U8dm9pZD4gewogIGxvYWRlciA9IGxvYWRlcl87CiAgd29ya2VyRGVidWcgPSBkZWJ1ZzsKICBteGZGaWxlID0gbmV3IE14ZkZpbGUobG9hZGVyLCBkZWJ1Zyk7CiAgbXBlZzJQaXBlbGluZSA9IG51bGw7CiAgc2NydWJTZWdtZW50Q2FjaGUuY2xlYXIoKTsKCiAgdHJ5IHsKICAgIGNvbnN0IGJvb3RzdHJhcCA9IGF3YWl0IG14ZkZpbGUub3BlbigpOwogICAgY29uc3QgeyBtZXRhZGF0YSB9ID0gYm9vdHN0cmFwOwogICAgZnJhZ21lbnRlciA9IG5ldyBNcDRGcmFnbWVudGVyKG1ldGFkYXRhKTsKICAgIGNvbnN0IHBkID0gbWV0YWRhdGEucGljdHVyZURlc2NyaXB0b3I7CiAgICBjb25zdCBzZCA9IG1ldGFkYXRhLnNvdW5kRGVzY3JpcHRvcjsKICAgIHN0b3JlZEVkaXRSYXRlTnVtZXJhdG9yID0gbWV0YWRhdGEuZWRpdFJhdGVOdW1lcmF0b3I7CiAgICBzdG9yZWRFZGl0UmF0ZURlbm9taW5hdG9yID0gbWV0YWRhdGEuZWRpdFJhdGVEZW5vbWluYXRvcjsKCiAgICAvLyBEZWNvZGUgdGhlIGZpcnN0IGVkaXQgdW5pdCdzIGF1ZGlvIHVwIGZyb250IHRvIGxlYXJuIHRoZSB0cnVlIFBDTSBjaGFubmVsIGNvdW50IChzZXBhcmF0ZS1tb25vCiAgICAvLyBhbmQgQUVTMyBsYXlvdXRzIGNhbiBkaWZmZXIgZnJvbSB0aGUgZGVzY3JpcHRvcidzIGNoYW5uZWxDb3VudCkuIFN1cmZhY2VkIGluIHRoZSBtYW5pZmVzdCBzbwogICAgLy8gdGhlIFVJIGNhbiBidWlsZCBhIGNoYW5uZWwgc2VsZWN0b3IgaW1tZWRpYXRlbHksIG5vdCBvbmx5IG9uY2UgYXVkaW8gc3RhcnRzIHBsYXlpbmcuCiAgICBsZXQgYXVkaW9DaGFubmVsQ291bnQgPSAwOwogICAgaWYgKHNkPy5jb2RlYyA9PT0gJ3BjbScpIHsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBhZXggPSBuZXcgRXNzZW5jZUV4dHJhY3Rvcihsb2FkZXJfLCBib290c3RyYXApOwogICAgICAgIGNvbnN0IGF1ZDogeyBlZGl0VW5pdDogYmlnaW50OyBkYXRhOiBBcnJheUJ1ZmZlcjsgYWVzMz86IGJvb2xlYW4gfVtdID0gW107CiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBmIG9mIGFleC5mZXRjaEZyYW1lcygwbiwgMikpIHsKICAgICAgICAgIGlmIChmLnRyYWNrVHlwZSA9PT0gJ2F1ZGlvJykgYXVkLnB1c2goeyBlZGl0VW5pdDogZi5lZGl0VW5pdCwgZGF0YTogZi5kYXRhLCBhZXMzOiBmLmFlczMgfSk7CiAgICAgICAgfQogICAgICAgIGlmIChhdWQubGVuZ3RoKSB7CiAgICAgICAgICBhdWRpb0NoYW5uZWxDb3VudCA9IGRlY29kZVBjbUVsZW1lbnRzKAogICAgICAgICAgICBhdWQsIHsgYml0RGVwdGg6IHNkLmJpdERlcHRoLCBibG9ja0FsaWduOiBzZC5ibG9ja0FsaWduLCBjaGFubmVsQ291bnQ6IHNkLmNoYW5uZWxDb3VudCB9LAogICAgICAgICAgKS5jaGFubmVsQ291bnQ7CiAgICAgICAgfQogICAgICB9IGNhdGNoIHsgLyogcmVmaW5lZCBsYXRlciBmcm9tIHBjbVNhbXBsZXMgaWYgdGhpcyBmYWlscyAqLyB9CiAgICB9CgogICAgY29uc3QgZHVyYXRpb25TZWMgPSBwZAogICAgICA/IE51bWJlcihtZXRhZGF0YS5kdXJhdGlvbikgKiAobWV0YWRhdGEuZWRpdFJhdGVEZW5vbWluYXRvciAvIG1ldGFkYXRhLmVkaXRSYXRlTnVtZXJhdG9yKQogICAgICA6IDA7CgogICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KICAgIC8vIE1QRUctMiBwYXRoOiB0cmFuc2NvZGUgdG8gSC4yNjQgc28gTVNFIC8gbmF0aXZlIHZpZGVvIGVsZW1lbnQgY2FuIHBsYXkKICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCiAgICBpZiAocGQ/LmNvZGVjID09PSAnbXBlZzInKSB7CiAgICAgIGNvbnN0IGV4dHJhY3RvciA9IG5ldyBFc3NlbmNlRXh0cmFjdG9yKGxvYWRlcl8sIGJvb3RzdHJhcCk7CiAgICAgIGxldCBmaXJzdFZpZGVvRnJhbWU6IEVzc2VuY2VGcmFtZSB8IG51bGwgPSBudWxsOwogICAgICAvLyBGZXRjaCB1cCB0byA1MCBmcmFtZXMg4oCUIGluIE9QMWEgaW50ZXJsZWF2ZWQgZmlsZXMgYXVkaW8gZnJhbWVzIG1heQogICAgICAvLyBwcmVjZWRlIHZpZGVvIGZyYW1lcyB3aXRoaW4gdGhlIHNhbWUgZWRpdCB1bml0IGJhdGNoLgogICAgICBmb3IgYXdhaXQgKGNvbnN0IGZyYW1lIG9mIGV4dHJhY3Rvci5mZXRjaEZyYW1lcygwbiwgNTApKSB7CiAgICAgICAgaWYgKGZyYW1lLnRyYWNrVHlwZSA9PT0gJ3ZpZGVvJykgeyBmaXJzdFZpZGVvRnJhbWUgPSBmcmFtZTsgYnJlYWs7IH0KICAgICAgfQogICAgICBpZiAoIWZpcnN0VmlkZW9GcmFtZSkgewogICAgICAgIHBvc3RFcnJvcignTVBFRy0yOiBubyB2aWRlbyBmcmFtZXMgZm91bmQgaW4gZmlyc3QgNTAgZWRpdCB1bml0cycsIHRydWUpOwogICAgICAgIHJldHVybjsKICAgICAgfQoKICAgICAgLy8gUHJvYmUtZGVjb2RlIHRoZSBmaXJzdCBmcmFtZSBmb3IgY29kZWQgZGltZW5zaW9ucyArIGNocm9tYSwgdGhlbiBidWlsZCB0aGUgdHJhbnNjb2RlCiAgICAgIC8vIHBpcGVsaW5lIChlbmNvZGVyIOKGkiBTUFMvUFBTIOKGkiBwZXJzaXN0ZW50IHN0cmVhbSBkZWNvZGVyKS4gU2VlIE1wZWcyUGlwZWxpbmUuCiAgICAgIGNvbnN0IHByb2JlID0gTXBlZzJQaXBlbGluZS5wcm9iZUZpcnN0RnJhbWUoZmlyc3RWaWRlb0ZyYW1lLmRhdGEpOwogICAgICBpZiAoIXByb2JlKSB7CiAgICAgICAgcG9zdEVycm9yKCdNUEVHLTI6IGZhaWxlZCB0byBkZWNvZGUgZmlyc3QgZnJhbWUnLCB0cnVlKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY29uc3QgcGlwZWxpbmUgPSBhd2FpdCBNcGVnMlBpcGVsaW5lLmNyZWF0ZShwcm9iZSwgc3RvcmVkRWRpdFJhdGVOdW1lcmF0b3IsIHN0b3JlZEVkaXRSYXRlRGVub21pbmF0b3IpOwogICAgICBpZiAoIXBpcGVsaW5lKSB7CiAgICAgICAgcG9zdEVycm9yKCdNUEVHLTI6IFZpZGVvRW5jb2RlciBkaWQgbm90IHByb2R1Y2UgU1BTL1BQUycsIHRydWUpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBtcGVnMlBpcGVsaW5lID0gcGlwZWxpbmU7CgogICAgICAvLyBVc2UgY29kZWQgKE1CLWFsaWduZWQpIGRpbWVuc2lvbnMgZm9yIHRoZSBhdmMxIGJveC4gQ2hyb21lJ3MgV2ViQ29kZWNzIFZpZGVvRW5jb2RlciBkb2VzIG5vdAogICAgICAvLyBpbnNlcnQgZnJhbWVfY3JvcHBpbmdfZmxhZyBpbiB0aGUgU1BTIGV2ZW4gd2hlbiBkaXNwbGF5SGVpZ2h0IDwgY29kZWRIZWlnaHQgKGUuZy4gMTA4MCB2cwogICAgICAvLyAxMDg4KTsgZGVjbGFyaW5nIDEwODAgaW4gdGhlIGF2YzEgYm94IHdoaWxlIHRoZSBTUFMgc2F5cyAiZGlzcGxheSA9IGNvZGVkID0gMTA4OCIgbWFrZXMKICAgICAgLy8gQ2hyb21lJ3MgTVNFIHBhcnNlciBmbGFnIGEgbWlzbWF0Y2ggYW5kIGZpcmUgYSBTb3VyY2VCdWZmZXIgZXJyb3IuIGNvZGVkSGVpZ2h0IGtlZXBzIHRoZQogICAgICAvLyBjb250YWluZXIgY29uc2lzdGVudCB3aXRoIHRoZSBTUFMuCiAgICAgIGZyYWdtZW50ZXIhLmVuYWJsZVRyYW5zY29kZU1vZGUocGlwZWxpbmUuc3BzLCBwaXBlbGluZS5wcHMsIHBpcGVsaW5lLmNvZGVkV2lkdGgsIHBpcGVsaW5lLmNvZGVkSGVpZ2h0KTsKCiAgICAgIC8vIFBDTSBhdWRpbyB1c2VzIFdlYiBBdWRpbyDigJQgc2tpcCBhdWRpbyB0cmFjayBmcm9tIG1vb3YgZW50aXJlbHkuIENocm9tZSBNU0UgcmVqZWN0cyBpbml0CiAgICAgIC8vIHNlZ21lbnRzIGNvbnRhaW5pbmcgdW5rbm93biBjb2RlYyBzYW1wbGUgZW50cmllcyAoc293dCkgZXZlbiBpbiBhIHZpZGVvLW9ubHkgU291cmNlQnVmZmVyLgogICAgICBjb25zdCBpbml0U2VnID0gZnJhZ21lbnRlciEuYnVpbGRJbml0U2VnbWVudChmYWxzZSk7CiAgICAgIGlmICh3b3JrZXJEZWJ1ZykgY29uc29sZS5sb2coJ1t3b3JrZXJdIE1QRUctMiB0cmFuc2NvZGUgaW5pdCBPSycsCiAgICAgICAgJ3NwczonLCBBcnJheS5mcm9tKHBpcGVsaW5lLnNwcykubWFwKGI9PmIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsJzAnKSkuam9pbignICcpLAogICAgICAgICdwcHM6JywgQXJyYXkuZnJvbShwaXBlbGluZS5wcHMpLm1hcChiPT5iLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCcwJykpLmpvaW4oJyAnKSwKICAgICAgICBgZGltczogJHtwaXBlbGluZS5kaXNwbGF5V2lkdGh9eCR7cGlwZWxpbmUuZGlzcGxheUhlaWdodH0gKGNvZGVkOiAke3BpcGVsaW5lLmNvZGVkV2lkdGh9eCR7cGlwZWxpbmUuY29kZWRIZWlnaHR9KWAsCiAgICAgICAgJ2luaXRTZWcgYnl0ZXM6JywgaW5pdFNlZy5sZW5ndGgsCiAgICAgICk7CgogICAgICBwb3N0KHsKICAgICAgICB0eXBlOiAnbWFuaWZlc3QnLAogICAgICAgIGR1cmF0aW9uOiBkdXJhdGlvblNlYywKICAgICAgICBlZGl0UmF0ZU51bWVyYXRvcjogc3RvcmVkRWRpdFJhdGVOdW1lcmF0b3IsCiAgICAgICAgZWRpdFJhdGVEZW5vbWluYXRvcjogc3RvcmVkRWRpdFJhdGVEZW5vbWluYXRvciwKICAgICAgICB0cmFja3M6IG1ldGFkYXRhLnBhY2thZ2VzLmZsYXRNYXAocCA9PiBwLnRyYWNrcyksCiAgICAgICAgcGljdHVyZURlc2NyaXB0b3I6IHBkLAogICAgICAgIHNvdW5kRGVzY3JpcHRvcjogc2QsCiAgICAgICAgdmlkZW9Db2RlY1N1cHBvcnRlZDogdHJ1ZSwKICAgICAgICBwY21Nc2VTdXBwb3J0ZWQ6IGZhbHNlLAogICAgICAgIC8vIENvZGVjIHN0cmluZyBmcm9tIHRoZSBhY3R1YWwgU1BTIGJ5dGVzIHNvIGl0IG1hdGNoZXMgdGhlIGNvbnN0cmFpbnQgYnl0ZSBpbiB0aGUgYXZjQyBib3gKICAgICAgICAvLyAoZGVjb2RlckNvbmZpZy5jb2RlYyBtYXkgcmVwb3J0IGNvbnN0cmFpbnRzPTB4MDAgd2hpbGUgdGhlIFNQUyBoYXMgZS5nLiAweDRjIOKAlCB0aGF0CiAgICAgICAgLy8gbWlzbWF0Y2ggY2F1c2VzIGEgU291cmNlQnVmZmVyIGVycm9yIHdoZW4gQ2hyb21lIGNoZWNrcyBNSU1FIHZzIGF2Y0Mgb24gaW5pdCBhcHBlbmQpLgogICAgICAgIHJlc29sdmVkVmlkZW9Db2RlYzogcGlwZWxpbmUuY29kZWNTdHJpbmcsCiAgICAgICAgcmVzb2x2ZWRWaWRlb01vZGU6ICdtc2UnLAogICAgICAgIGluZGV4TW9kZTogYm9vdHN0cmFwLmluZGV4TW9kZSwKICAgICAgICBhdWRpb0NoYW5uZWxDb3VudCwKICAgICAgfSk7CgogICAgICBjb25zdCBpbml0QnVmID0gaW5pdFNlZy5idWZmZXIuc2xpY2UoaW5pdFNlZy5ieXRlT2Zmc2V0LCBpbml0U2VnLmJ5dGVPZmZzZXQgKyBpbml0U2VnLmJ5dGVMZW5ndGgpIGFzIEFycmF5QnVmZmVyOwogICAgICBwb3N0KHsgdHlwZTogJ2luaXRTZWdtZW50JywgZGF0YTogaW5pdEJ1ZiB9LCBbaW5pdEJ1Zl0pOwogICAgICByZXR1cm47CiAgICB9CgogICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KICAgIC8vIEguMjY0IHBhdGg6IHByZS1mZXRjaCBmaXJzdCBmcmFtZSB0byBnZXQgU1BTL1BQUwogICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KICAgIGxldCB2aWRlb0NvZGVjU3VwcG9ydGVkID0gdHJ1ZTsKICAgIGxldCBwZW5kaW5nVmlkZW9Jbml0OiB7IGNvZGVjOiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBVaW50OEFycmF5OyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7CgogICAgaWYgKHBkPy5jb2RlYyA9PT0gJ2gyNjQnKSB7CiAgICAgIC8vIFRoZSBpbml0IHNlZ21lbnQncyBhdmMxL2F2Y0MgYm94IGlzIGJ1aWx0IGZyb20gdGhlIFNQUy9QUFMgaW4gdGhlIEZJUlNUIHZpZGVvIGZyYW1lIChpdCBtdXN0CiAgICAgIC8vIGJlIGEga2V5ZnJhbWUgY2FycnlpbmcgcGFyYW1ldGVyIHNldHMpLiBJZiB0aGF0IGV4dHJhY3Rpb24gZmFpbHMgdGhlcmUgaXMgbm8gY29ycmVjdCBpbml0CiAgICAgIC8vIHNlZ21lbnQgdG8gYnVpbGQsIHNvIGZhaWwgbG91ZGx5IHJhdGhlciB0aGFuIGd1ZXNzaW5nIGRpbWVuc2lvbnMgKHNlZSBtcDQtZnJhZ21lbnRlcikuCiAgICAgIGxldCBnb3RTcHNQcHMgPSBmYWxzZTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBleHRyYWN0b3IgPSBuZXcgRXNzZW5jZUV4dHJhY3Rvcihsb2FkZXJfLCBib290c3RyYXApOwogICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgZXh0cmFjdG9yLmZldGNoRnJhbWVzKDBuLCAxKSkgewogICAgICAgICAgaWYgKGZyYW1lLnRyYWNrVHlwZSAhPT0gJ3ZpZGVvJykgY29udGludWU7CiAgICAgICAgICBjb25zdCBhdmNjRGF0YSA9IGlzQW5uZXhCKGZyYW1lLmRhdGEpID8gYW5uZXhCdG9BVkNDKGZyYW1lLmRhdGEpIDogZnJhbWUuZGF0YTsKICAgICAgICAgIGNvbnN0IHsgc3BzLCBwcHMgfSA9IGV4dHJhY3RTUFNQUFMoYXZjY0RhdGEpOwogICAgICAgICAgaWYgKHNwcy5sZW5ndGggPiAwICYmIHBwcy5sZW5ndGggPiAwKSB7CiAgICAgICAgICAgIGdvdFNwc1BwcyA9IHRydWU7CiAgICAgICAgICAgIGZyYWdtZW50ZXIhLnNldFNQU1BQUyhzcHNbMF0sIHBwc1swXSk7CiAgICAgICAgICAgIGlmICh2aWRlb01vZGUgPT09ICd3ZWJjb2RlY3MnKSB7CiAgICAgICAgICAgICAgY29uc3QgZGVzYyA9IGJ1aWxkQVZDRGVjb2RlckNvbmZpZ1JlY29yZChzcHNbMF0sIHBwc1swXSk7CiAgICAgICAgICAgICAgY29uc3QgcCA9IHNwc1swXVsxXSwgYyA9IHNwc1swXVsyXSwgbCA9IHNwc1swXVszXTsKICAgICAgICAgICAgICBjb25zdCBjb2RlYyA9IGBhdmMxLiR7cC50b1N0cmluZygxNikucGFkU3RhcnQoMiwnMCcpfSR7Yy50b1N0cmluZygxNikucGFkU3RhcnQoMiwnMCcpfSR7bC50b1N0cmluZygxNikucGFkU3RhcnQoMiwnMCcpfWA7CiAgICAgICAgICAgICAgcGVuZGluZ1ZpZGVvSW5pdCA9IHsgY29kZWMsIGRlc2NyaXB0aW9uOiBkZXNjLCB3aWR0aDogcGQud2lkdGgsIGhlaWdodDogcGQuaGVpZ2h0IH07CiAgICAgICAgICAgIH0KICAgICAgICAgIH0KICAgICAgICAgIGJyZWFrOwogICAgICAgIH0KICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIHBvc3RFcnJvcihgSC4yNjQ6IGZhaWxlZCB0byByZWFkIFNQUy9QUFMgZnJvbSB0aGUgZmlyc3QgZnJhbWU6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsIHRydWUpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBpZiAoIWdvdFNwc1BwcykgewogICAgICAgIHBvc3RFcnJvcignSC4yNjQ6IG5vIFNQUy9QUFMgaW4gdGhlIGZpcnN0IHZpZGVvIGZyYW1lIOKAlCBjYW5ub3QgYnVpbGQgYW4gaW5pdCBzZWdtZW50ICh0aGUgZmlyc3QgZnJhbWUgbXVzdCBiZSBhIGtleWZyYW1lIGNhcnJ5aW5nIHBhcmFtZXRlciBzZXRzKScsIHRydWUpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgfQoKICAgIGNvbnN0IHJlc29sdmVkTW9kZTogJ21zZScgfCAnd2ViY29kZWNzJyA9CiAgICAgICh2aWRlb01vZGUgPT09ICd3ZWJjb2RlY3MnICYmIHBlbmRpbmdWaWRlb0luaXQpID8gJ3dlYmNvZGVjcycgOiAnbXNlJzsKCiAgICBwb3N0KHsKICAgICAgdHlwZTogJ21hbmlmZXN0JywKICAgICAgZHVyYXRpb246IGR1cmF0aW9uU2VjLAogICAgICBlZGl0UmF0ZU51bWVyYXRvcjogc3RvcmVkRWRpdFJhdGVOdW1lcmF0b3IsCiAgICAgIGVkaXRSYXRlRGVub21pbmF0b3I6IHN0b3JlZEVkaXRSYXRlRGVub21pbmF0b3IsCiAgICAgIHRyYWNrczogbWV0YWRhdGEucGFja2FnZXMuZmxhdE1hcChwID0+IHAudHJhY2tzKSwKICAgICAgcGljdHVyZURlc2NyaXB0b3I6IHBkLAogICAgICBzb3VuZERlc2NyaXB0b3I6IHNkLAogICAgICB2aWRlb0NvZGVjU3VwcG9ydGVkLAogICAgICBwY21Nc2VTdXBwb3J0ZWQ6IGZhbHNlLAogICAgICByZXNvbHZlZFZpZGVvQ29kZWM6IHBkPy5jb2RlYyA/PyAndW5rbm93bicsCiAgICAgIHJlc29sdmVkVmlkZW9Nb2RlOiByZXNvbHZlZE1vZGUsCiAgICAgIGluZGV4TW9kZTogYm9vdHN0cmFwLmluZGV4TW9kZSwKICAgICAgYXVkaW9DaGFubmVsQ291bnQsCiAgICB9KTsKCiAgICBpZiAocmVzb2x2ZWRNb2RlID09PSAnd2ViY29kZWNzJyAmJiBwZW5kaW5nVmlkZW9Jbml0KSB7CiAgICAgIGNvbnN0IHsgY29kZWMsIGRlc2NyaXB0aW9uLCB3aWR0aCwgaGVpZ2h0IH0gPSBwZW5kaW5nVmlkZW9Jbml0OwogICAgICBjb25zdCBkZXNjQnVmID0gZGVzY3JpcHRpb24uYnVmZmVyLnNsaWNlKGRlc2NyaXB0aW9uLmJ5dGVPZmZzZXQsIGRlc2NyaXB0aW9uLmJ5dGVPZmZzZXQgKyBkZXNjcmlwdGlvbi5ieXRlTGVuZ3RoKSBhcyBBcnJheUJ1ZmZlcjsKICAgICAgcG9zdCh7IHR5cGU6ICd2aWRlb0luaXQnLCBjb2RlYywgZGVzY3JpcHRpb246IGRlc2NCdWYsIHdpZHRoLCBoZWlnaHQgfSwgW2Rlc2NCdWZdKTsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IGluY2x1ZGVBdWRpbyA9IHNkPy5jb2RlYyAhPT0gJ3BjbSc7IC8vIFBDTSB1c2VzIFdlYiBBdWRpbyDigJQgc2tpcCBmcm9tIG1vb3YKICAgICAgY29uc3QgaW5pdFNlZyA9IGZyYWdtZW50ZXIhLmJ1aWxkSW5pdFNlZ21lbnQoaW5jbHVkZUF1ZGlvKTsKICAgICAgY29uc3QgaW5pdEJ1ZiA9IGluaXRTZWcuYnVmZmVyLnNsaWNlKGluaXRTZWcuYnl0ZU9mZnNldCwgaW5pdFNlZy5ieXRlT2Zmc2V0ICsgaW5pdFNlZy5ieXRlTGVuZ3RoKSBhcyBBcnJheUJ1ZmZlcjsKICAgICAgcG9zdCh7IHR5cGU6ICdpbml0U2VnbWVudCcsIGRhdGE6IGluaXRCdWYgfSwgW2luaXRCdWZdKTsKICAgIH0KCiAgfSBjYXRjaCAoZSkgewogICAgcG9zdEVycm9yKGBGYWlsZWQgdG8gcGFyc2UgTVhGOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLCB0cnVlKTsKICB9Cn0KCmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUZldGNoU2VnbWVudCgKICBzdGFydEZyYW1lOiBudW1iZXIsCiAgZnJhbWVDb3VudDogbnVtYmVyLAogIHNlcUJhc2U6IG51bWJlciwKICBnZW46IG51bWJlciwKICBzdHJldGNoVG9GcmFtZXMgPSAwLAogIHByZXZpZXdTZXE/OiBudW1iZXIsCik6IFByb21pc2U8dm9pZD4gewogIC8vIEEgc2NydWIgcHJldmlldyBpcyBhIHRocm93YXdheSBzaW5nbGUtZnJhbWUgZGVjb2RlIHRoYXQgbXVzdCBhbHdheXMgYW5zd2VyIHdpdGggcHJldmlld0RvbmUKICAvLyAoc28gdGhlIHBsYXllcidzIHNpbmdsZS1mbGlnaHQgcHVtcCBuZXZlciBkZWFkbG9ja3MpIGFuZCBtdXN0IHNraXAgYXVkaW8uCiAgY29uc3QgaXNTY3J1YlByZXZpZXcgPSBwcmV2aWV3U2VxICE9PSB1bmRlZmluZWQ7CiAgaWYgKCFsb2FkZXIgfHwgIW14ZkZpbGUgfHwgIWZyYWdtZW50ZXIpIHsKICAgIHBvc3RFcnJvcignTm90IGluaXRpYWxpemVkJyk7CiAgICBpZiAoaXNTY3J1YlByZXZpZXcpIHBvc3QoeyB0eXBlOiAncHJldmlld0RvbmUnLCBzZXE6IHByZXZpZXdTZXEhLCBlZGl0VW5pdDogc3RhcnRGcmFtZSB9KTsKICAgIHJldHVybjsKICB9CiAgY29uc3QgYm9vdHN0cmFwID0gbXhmRmlsZS5nZXRCb290c3RyYXAoKTsKICBpZiAoIWJvb3RzdHJhcCkgewogICAgcG9zdEVycm9yKCdCb290c3RyYXAgbm90IGNvbXBsZXRlJyk7CiAgICBpZiAoaXNTY3J1YlByZXZpZXcpIHBvc3QoeyB0eXBlOiAncHJldmlld0RvbmUnLCBzZXE6IHByZXZpZXdTZXEhLCBlZGl0VW5pdDogc3RhcnRGcmFtZSB9KTsKICAgIHJldHVybjsKICB9CgogIHRyeSB7CiAgICBjb25zdCBleHRyYWN0b3IgPSBuZXcgRXNzZW5jZUV4dHJhY3Rvcihsb2FkZXIsIGJvb3RzdHJhcCk7CiAgICBjb25zdCBmcmFtZXM6IEVzc2VuY2VGcmFtZVtdID0gW107CiAgICAvLyBUaGUgTVBFRy0yIHRyYW5zY29kZSBwYXRoIGZlZWRzIG9uZSBwZXJzaXN0ZW50IGRlY29kZXIsIHNvIGl0IG5lZWRzIHRoZSBleGFjdAogICAgLy8gY29uc2VjdXRpdmUgZnJhbWUgcmFuZ2UgKG5vIGtleWZyYW1lIHNuYXBwaW5nKSB0byBhdm9pZCByZS1mZWVkaW5nIHBpY3R1cmVzIGl0IGhhcwogICAgLy8gYWxyZWFkeSBkZWNvZGVkLiBTZWVrcyBsYW5kIG9uIGEga2V5ZnJhbWUgYW55d2F5LCB3aGVyZSBleGFjdCBhbmQgc25hcHBlZCBhZ3JlZS4KICAgIGNvbnN0IGV4YWN0ID0gISFtcGVnMlBpcGVsaW5lOwogICAgZm9yIGF3YWl0IChjb25zdCBmcmFtZSBvZiBleHRyYWN0b3IuZmV0Y2hGcmFtZXMoQmlnSW50KHN0YXJ0RnJhbWUpLCBmcmFtZUNvdW50LCBleGFjdCkpIHsKICAgICAgZnJhbWVzLnB1c2goZnJhbWUpOwogICAgfQoKICAgIC8vIEEgc2VlayBhcnJpdmVkIHdoaWxlIHdlIHdlcmUgcmVhZGluZyBieXRlczogdGhlIGRlY29kZXIgaGFzIGJlZW4gcmVzZXQgdG8gYSBuZXcKICAgIC8vIHBvc2l0aW9uLCBzbyBmZWVkaW5nIGl0IHRoZXNlIChub3cgc3RhbGUpIGZyYW1lcyB3b3VsZCBjb3JydXB0IHRoZSBwb3N0LXNlZWsgZGVjb2RlLgogICAgLy8gRHJvcCB0aGlzIGZldGNoIGVudGlyZWx5OyB0aGUgcGxheWVyIGlzc3VlcyBhIGZyZXNoIGZldGNoIGFmdGVyIHRoZSAnc2Vla2VkJyBldmVudC4KICAgIGlmIChnZW4gIT09IGZldGNoUS5jdXJyZW50R2VuZXJhdGlvbikgcmV0dXJuOwoKICAgIGNvbnN0IHZpZGVvRnJhbWVzID0gZnJhbWVzLmZpbHRlcihmID0+IGYudHJhY2tUeXBlID09PSAndmlkZW8nKTsKICAgIGNvbnN0IGF1ZGlvRnJhbWVzID0gZnJhbWVzLmZpbHRlcihmID0+IGYudHJhY2tUeXBlID09PSAnYXVkaW8nKTsKCiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQogICAgLy8gTVBFRy0yIOKGkiBILjI2NCB0cmFuc2NvZGUKICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCiAgICBpZiAobXBlZzJQaXBlbGluZSkgewogICAgICBpZiAodmlkZW9GcmFtZXMubGVuZ3RoID4gMCkgewogICAgICAgIGNvbnN0IHBpcGVsaW5lID0gbXBlZzJQaXBlbGluZTsKCiAgICAgICAgLy8gVGhlIGRlY29kZXIgaG9sZHMgaXRzIGZpbmFsIEkvUCBhbmNob3IgYmFjayBmb3IgZGlzcGxheSByZW9yZGVyaW5nLiBEdXJpbmcgbm9ybWFsIHBsYXliYWNrCiAgICAgICAgLy8ga2VlcCBpdCBoZWxkIHNvIHRoZSBuZXh0IHNlZ21lbnQgZW1pdHMgaXQgaW4gb3JkZXI7IGZsdXNoIGl0IG9ubHkgYXQgZW5kLW9mLXN0cmVhbSAoZmV3ZXIKICAgICAgICAvLyBmcmFtZXMgcmV0dXJuZWQgdGhhbiByZXF1ZXN0ZWQpLCBmb3IgYSBrZXlmcmFtZS1vbmx5IHByZXZpZXcgKGEgc2luZ2xlIGludHJhIHBpY3R1cmUgdGhhdAogICAgICAgIC8vIHdvdWxkIG90aGVyd2lzZSBzdGF5IGhlbGQpLCBvciBmb3IgYSB0aHJvd2F3YXkgc2NydWIgcHJldmlldyAobm8gbmV4dCBzZWdtZW50IHBpY2tzIGl0IHVwKS4KICAgICAgICBjb25zdCBrZXlmcmFtZVByZXZpZXcgPSBzdHJldGNoVG9GcmFtZXMgPiAwOwogICAgICAgIGNvbnN0IGF0RW5kT2ZTdHJlYW0gPSB2aWRlb0ZyYW1lcy5sZW5ndGggPCBmcmFtZUNvdW50OwogICAgICAgIGNvbnN0IGZsdXNoSGVsZEFuY2hvciA9IGF0RW5kT2ZTdHJlYW0gfHwga2V5ZnJhbWVQcmV2aWV3IHx8IGlzU2NydWJQcmV2aWV3OwoKICAgICAgICAvLyBUaGUgZGVjb2RlIGxvb3AgYmFpbHMgdGhlIG1vbWVudCBhIHNlZWsvc2NydWIgc3VwZXJzZWRlcyB0aGlzIGZldGNoIChvdGhlcndpc2UgYSBzY3J1YgogICAgICAgIC8vIHByZXZpZXcgY2FuJ3Qgc3RhcnQgdW50aWwgdGhlIHdob2xlIGluLWZsaWdodCBjaHVuayBmaW5pc2hlcyk7IGZsdXNoKCkgc3RpbGwgcnVucyBzbyB0aGUKICAgICAgICAvLyBzaGFyZWQgZW5jb2RlciBxdWV1ZSBpcyBkcmFpbmVkIGNsZWFuIOKAlCBidXQgaWYgc3VwZXJzZWRlZCB3ZSBkcm9wIHRoZSBjaHVua3MgYmVsb3cuCiAgICAgICAgY29uc3QgeyBjaHVua3MsIGZyYW1lc0VtaXR0ZWQsIGRlY29kZU1zLCBlbmNvZGVNcyB9ID0gYXdhaXQgcGlwZWxpbmUuZGVjb2RlU2VnbWVudCgKICAgICAgICAgIHZpZGVvRnJhbWVzLCBmbHVzaEhlbGRBbmNob3IsICgpID0+IGdlbiAhPT0gZmV0Y2hRLmN1cnJlbnRHZW5lcmF0aW9uLAogICAgICAgICk7CiAgICAgICAgaWYgKGdlbiAhPT0gZmV0Y2hRLmN1cnJlbnRHZW5lcmF0aW9uKSByZXR1cm47CgogICAgICAgIGNvbnN0IG4gPSBNYXRoLm1heCgxLCBmcmFtZXNFbWl0dGVkKTsKICAgICAgICBpZiAod29ya2VyRGVidWcpIGNvbnNvbGUubG9nKAogICAgICAgICAgYFt0cmFuc2NvZGVdIHN0YXJ0RnJhbWU9JHtzdGFydEZyYW1lfTogJHt2aWRlb0ZyYW1lcy5sZW5ndGh9IEVTIGZyYW1lcyDihpIgJHtmcmFtZXNFbWl0dGVkfSBmcmFtZXMgfCBgICsKICAgICAgICAgIGBkZWNvZGUrcHJlcCAke2RlY29kZU1zLnRvRml4ZWQoMCl9IG1zICgkeyhkZWNvZGVNcyAvIG4pLnRvRml4ZWQoMSl9IG1zL2YpIHwgYCArCiAgICAgICAgICBgZW5jb2RlIGRyYWluICR7ZW5jb2RlTXMudG9GaXhlZCgwKX0gbXMgKCR7KGVuY29kZU1zIC8gbikudG9GaXhlZCgxKX0gbXMvZikgfCBgICsKICAgICAgICAgIGB0b3RhbCAkeyhkZWNvZGVNcyArIGVuY29kZU1zKS50b0ZpeGVkKDApfSBtc2AsCiAgICAgICAgKTsKCiAgICAgICAgY29uc3Qgc2VnID0gZnJhZ21lbnRlci5idWlsZFRyYW5zY29kZWRWaWRlb1NlZ21lbnQoCiAgICAgICAgICBjaHVua3MsCiAgICAgICAgICBrZXlmcmFtZVByZXZpZXcgPyB7IHRvdGFsRHVyYXRpb25GcmFtZXM6IHN0cmV0Y2hUb0ZyYW1lcyB9IDogdW5kZWZpbmVkLAogICAgICAgICk7CiAgICAgICAgaWYgKHNlZyAmJiBpc1NjcnViUHJldmlldykgewogICAgICAgICAgLy8gQ2FjaGUgYSBjb3B5IGtleWVkIGJ5IHRoZSBHT1AtaGVhZCBrZXlmcmFtZSAoPSBzdGFydEZyYW1lIGhlcmUpIHNvIGZ1dHVyZSBzY3J1YgogICAgICAgICAgLy8gdmlzaXRzIHRvIHRoaXMgR09QIHNraXAgdGhlIGRlY29kZS9lbmNvZGUgZW50aXJlbHkgKHNlZSBzY3J1YlNlZ21lbnRDYWNoZSkuCiAgICAgICAgICBzY3J1YlNlZ21lbnRDYWNoZS5zZXQoc3RhcnRGcmFtZSwgc2VnLnNsaWNlKCkpOwogICAgICAgIH0KICAgICAgICBpZiAoc2VnKSB7CiAgICAgICAgICBpZiAod29ya2VyRGVidWcpIGNvbnNvbGUubG9nKCdbd29ya2VyXSB2aWRlb1NlZ21lbnQnLCBzZWcubGVuZ3RoLCAnYnl0ZXMsJywgY2h1bmtzLmxlbmd0aCwgJ2NodW5rcywgZmlyc3QgY2h1bmsga2V5ZnJhbWU6JywgY2h1bmtzWzBdPy5pc0tleWZyYW1lLCAnZmlyc3QgY2h1bmsgZWRpdFVuaXQ6JywgY2h1bmtzWzBdID8gTnVtYmVyKGNodW5rc1swXS5lZGl0VW5pdCkgOiAtMSwga2V5ZnJhbWVQcmV2aWV3ID8gYChrZXlmcmFtZSBwcmV2aWV3LCBzdHJldGNoICR7c3RyZXRjaFRvRnJhbWVzfWYpYCA6ICcnKTsKICAgICAgICAgIHBvc3QoCiAgICAgICAgICAgIHsgdHlwZTogJ3ZpZGVvU2VnbWVudCcsIGRhdGE6IHNlZy5idWZmZXIgYXMgQXJyYXlCdWZmZXIsIHNlcTogc2VxQmFzZSwgZWRpdFVuaXQ6IHN0YXJ0RnJhbWUgfSwKICAgICAgICAgICAgW3NlZy5idWZmZXJdLAogICAgICAgICAgKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0gZWxzZSB7CiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCiAgICAgIC8vIEguMjY0IC8gV2ViQ29kZWNzIHBhdGggKHVuY2hhbmdlZCkKICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KICAgICAgaWYgKHZpZGVvRnJhbWVzLmxlbmd0aCA+IDApIHsKICAgICAgICBpZiAodmlkZW9Nb2RlID09PSAnd2ViY29kZWNzJykgewogICAgICAgICAgY29uc3QgZnJhbWVEdXJhdGlvblVzID0gTWF0aC5yb3VuZChzdG9yZWRFZGl0UmF0ZURlbm9taW5hdG9yICogMV8wMDBfMDAwIC8gc3RvcmVkRWRpdFJhdGVOdW1lcmF0b3IpOwogICAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiB2aWRlb0ZyYW1lcykgewogICAgICAgICAgICBjb25zdCBhdmNjQnVmOiBBcnJheUJ1ZmZlciA9IGlzQW5uZXhCKGZyYW1lLmRhdGEpCiAgICAgICAgICAgICAgPyBhbm5leEJ0b0FWQ0MoZnJhbWUuZGF0YSkKICAgICAgICAgICAgICA6IChmcmFtZS5kYXRhIGFzIEFycmF5QnVmZmVyKS5zbGljZSgwKTsKICAgICAgICAgICAgY29uc3QgdHNVcyA9IE1hdGgucm91bmQoTnVtYmVyKGZyYW1lLmVkaXRVbml0KSAqIHN0b3JlZEVkaXRSYXRlRGVub21pbmF0b3IgKiAxXzAwMF8wMDAgLyBzdG9yZWRFZGl0UmF0ZU51bWVyYXRvcik7CiAgICAgICAgICAgIHBvc3QoCiAgICAgICAgICAgICAgeyB0eXBlOiAndmlkZW9DaHVuaycsIGRhdGE6IGF2Y2NCdWYsIHRpbWVzdGFtcDogdHNVcywgZHVyYXRpb246IGZyYW1lRHVyYXRpb25Vcywga2V5ZnJhbWU6IGZyYW1lLmlzS2V5ZnJhbWUgfSwKICAgICAgICAgICAgICBbYXZjY0J1Zl0sCiAgICAgICAgICAgICk7CiAgICAgICAgICB9CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIGNvbnN0IHNlZyA9IGZyYWdtZW50ZXIuYnVpbGRWaWRlb1NlZ21lbnQodmlkZW9GcmFtZXMpOwogICAgICAgICAgaWYgKHNlZykgewogICAgICAgICAgICBpZiAoaXNTY3J1YlByZXZpZXcpIHsKICAgICAgICAgICAgICAvLyBDYWNoZSB0aGUgKGFsbC1pbnRyYSkgcHJldmlldyBzZWdtZW50IHNvIHJldmlzaXRpbmcgdGhpcyBmcmFtZSBhdm9pZHMgdGhlIGRpc2sgcmVhZAogICAgICAgICAgICAgIC8vICsgcmVtdXguIEtleWVkIGJ5IHN0YXJ0RnJhbWUgKD0gdGhlIHJlcXVlc3RlZCBrZXlmcmFtZSkuIFNlZSBzY3J1YlNlZ21lbnRDYWNoZS4KICAgICAgICAgICAgICBzY3J1YlNlZ21lbnRDYWNoZS5zZXQoc3RhcnRGcmFtZSwgc2VnLnNsaWNlKCkpOwogICAgICAgICAgICB9CiAgICAgICAgICAgIHBvc3QoCiAgICAgICAgICAgICAgeyB0eXBlOiAndmlkZW9TZWdtZW50JywgZGF0YTogc2VnLmJ1ZmZlciBhcyBBcnJheUJ1ZmZlciwgc2VxOiBzZXFCYXNlLCBlZGl0VW5pdDogc3RhcnRGcmFtZSB9LAogICAgICAgICAgICAgIFtzZWcuYnVmZmVyXSwKICAgICAgICAgICAgKTsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0KCiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQogICAgLy8gQXVkaW8gKHNraXBwZWQgZm9yIHRocm93YXdheSBzY3J1YiBwcmV2aWV3cyDigJQgdmlkZW8tb25seSkKICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCiAgICBpZiAoIWlzU2NydWJQcmV2aWV3ICYmIGF1ZGlvRnJhbWVzLmxlbmd0aCA+IDApIHsKICAgICAgY29uc3Qgc2QgPSBib290c3RyYXAubWV0YWRhdGEuc291bmREZXNjcmlwdG9yOwogICAgICBpZiAoc2Q/LmNvZGVjID09PSAncGNtJykgewogICAgICAgIC8vIE1YRiBQQ00gaXMgbGl0dGxlLWVuZGlhbiBzaWduZWQgYXQgdGhlIGRlc2NyaXB0b3IncyBiaXQgZGVwdGggKDI0LWJpdCBmb3IgdGhlc2UKICAgICAgICAvLyBmaWxlcywgbm90IDE2KS4gQ2hhbm5lbHMgYXJyaXZlIGVpdGhlciBhcyBvbmUgaW50ZXJsZWF2ZWQgZWxlbWVudCBvciBhcyBOIHNlcGFyYXRlCiAgICAgICAgLy8gbW9ubyBlbGVtZW50cyBwZXIgZWRpdCB1bml0OyBkZWNvZGVQY21FbGVtZW50cyBoYW5kbGVzIGJvdGgg4oaSIGludGVybGVhdmVkIEZsb2F0MzIuCiAgICAgICAgY29uc3QgeyBzYW1wbGVzOiBmbG9hdDMyLCBjaGFubmVsQ291bnQgfSA9IGRlY29kZVBjbUVsZW1lbnRzKAogICAgICAgICAgYXVkaW9GcmFtZXMubWFwKGYgPT4gKHsgZWRpdFVuaXQ6IGYuZWRpdFVuaXQsIGRhdGE6IGYuZGF0YSwgYWVzMzogZi5hZXMzIH0pKSwKICAgICAgICAgIHsgYml0RGVwdGg6IHNkLmJpdERlcHRoLCBibG9ja0FsaWduOiBzZC5ibG9ja0FsaWduLCBjaGFubmVsQ291bnQ6IHNkLmNoYW5uZWxDb3VudCB9LAogICAgICAgICk7CiAgICAgICAgcG9zdCgKICAgICAgICAgIHsgdHlwZTogJ3BjbVNhbXBsZXMnLCBzYW1wbGVzOiBmbG9hdDMyLCBlZGl0VW5pdDogc3RhcnRGcmFtZSwgc2FtcGxlUmF0ZTogc2Quc2FtcGxlUmF0ZSwgY2hhbm5lbENvdW50IH0sCiAgICAgICAgICBbZmxvYXQzMi5idWZmZXJdLAogICAgICAgICk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY29uc3Qgc2VnID0gZnJhZ21lbnRlci5idWlsZEF1ZGlvU2VnbWVudChhdWRpb0ZyYW1lcyk7CiAgICAgICAgaWYgKHNlZykgewogICAgICAgICAgcG9zdCgKICAgICAgICAgICAgeyB0eXBlOiAnYXVkaW9TZWdtZW50JywgZGF0YTogc2VnLmJ1ZmZlciBhcyBBcnJheUJ1ZmZlciwgc2VxOiBzZXFCYXNlICsgMSwgZWRpdFVuaXQ6IHN0YXJ0RnJhbWUgfSwKICAgICAgICAgICAgW3NlZy5idWZmZXJdLAogICAgICAgICAgKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KCiAgICBpZiAoIWlzU2NydWJQcmV2aWV3KSBwb3N0KHsgdHlwZTogJ3NlZ21lbnREb25lJyB9KTsKCiAgfSBjYXRjaCAoZSkgewogICAgcG9zdEVycm9yKGBGYWlsZWQgdG8gZmV0Y2ggc2VnbWVudDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7CiAgfSBmaW5hbGx5IHsKICAgIC8vIEFsd2F5cyBhbnN3ZXIgYSBzY3J1YiBwcmV2aWV3LCBldmVuIHdoZW4gc3VwZXJzZWRlZCAoZ2VuIG1pc21hdGNoIHJldHVybnMgYWJvdmUpIG9yIGVycm9yZWQsCiAgICAvLyBzbyB0aGUgcGxheWVyJ3Mgc2luZ2xlLWZsaWdodCBwdW1wIGNhbiBmaXJlIHRoZSBuZXh0IHByZXZpZXcgYXQgdGhlIGxhdGVzdCBkcmFnZ2VkIHBvc2l0aW9uLgogICAgaWYgKGlzU2NydWJQcmV2aWV3KSBwb3N0KHsgdHlwZTogJ3ByZXZpZXdEb25lJywgc2VxOiBwcmV2aWV3U2VxISwgZWRpdFVuaXQ6IHN0YXJ0RnJhbWUgfSk7CiAgfQp9CgpmdW5jdGlvbiBoYW5kbGVTZWVrKHRhcmdldEZyYW1lOiBudW1iZXIpOiB2b2lkIHsKICBpZiAoIW14ZkZpbGUpIHsgcG9zdEVycm9yKCdOb3QgaW5pdGlhbGl6ZWQnKTsgcmV0dXJuOyB9CiAgY29uc3QgYm9vdHN0cmFwID0gbXhmRmlsZS5nZXRCb290c3RyYXAoKTsKICBpZiAoIWJvb3RzdHJhcCkgeyBwb3N0RXJyb3IoJ0Jvb3RzdHJhcCBub3QgY29tcGxldGUnKTsgcmV0dXJuOyB9CgogIC8vIFJlc2V0IE1QRUctMiB0cmFuc2NvZGUgc3RhdGUgb24gc2Vlay4gRHJvcHBpbmcgdGhlIGRlY29kZXIncyByZWZlcmVuY2UgZnJhbWVzIGlzCiAgLy8gcmVxdWlyZWQ6IHRoZSBwb3N0LXNlZWsgZmV0Y2ggc3RhcnRzIGF0IGEga2V5ZnJhbWUgKEdPUCBib3VuZGFyeSwgY2FycnlpbmcgYSBmcmVzaAogIC8vIHNlcXVlbmNlIGhlYWRlciksIGFuZCBzdGFsZSByZWZlcmVuY2VzIGZyb20gdGhlIG9sZCBwb3NpdGlvbiB3b3VsZCBjb3JydXB0IHRoZQogIC8vIGZpcnN0IGRlY29kZWQgcGljdHVyZXMuIFRoZSBjb3VudGVyIGlzIHJlc2V0IHNvIHRpbWVzdGFtcHMgcmVzdW1lIGZyb20gdGhlIHNlZWsgcG9pbnQuCiAgY29uc3QgcmVzb2x2ZWRTZWVrID0gcmVzb2x2ZUZyYW1lT2Zmc2V0KAogICAgYm9vdHN0cmFwLmluZGV4U2VnbWVudHMsCiAgICBCaWdJbnQodGFyZ2V0RnJhbWUpLAogICAgYm9vdHN0cmFwLmVzc2VuY2VTdGFydCwKICAgIGJvb3RzdHJhcC5lc3NlbmNlQm9keVNJRCwKICApOwogIC8vIFN1cGVyc2VkZSBhbnkgcXVldWVkL2luLWZsaWdodCBmZXRjaCBmcm9tIHRoZSBvbGQgcG9zaXRpb24gKHNlZSBGZXRjaFF1ZXVlLnN1cGVyc2VkZSk6IGFuCiAgLy8gaW4tZmxpZ2h0IGZldGNoIGNoZWNrcyB0aGUgZ2VuZXJhdGlvbiBhZnRlciBpdHMgYXdhaXRzIGFuZCBkaXNjYXJkcyBpdHMgbm93LXN0YWxlIGZyYW1lcy4KICBmZXRjaFEuc3VwZXJzZWRlKCk7CgogIGNvbnN0IG5lYXJlc3RLZXlmcmFtZSA9IHJlc29sdmVkU2VlayA/IE51bWJlcihyZXNvbHZlZFNlZWsubmVhcmVzdEtleWZyYW1lRWRpdFVuaXQpIDogdGFyZ2V0RnJhbWU7CiAgLy8gUmVzZXRzIHRoZSBkZWNvZGVyJ3MgcmVmZXJlbmNlcyArIHJlc3VtZXMgdGhlIGVkaXQtdW5pdCBjb3VudGVyIGZyb20gdGhlIGtleWZyYW1lIChuby1vcCBmb3IKICAvLyB0aGUgSC4yNjQgcGF0aCwgd2hlcmUgdGhlcmUgaXMgbm8gcGlwZWxpbmUgYW5kIHRoZSBjb3VudGVyIGlzIHVudXNlZCkuCiAgbXBlZzJQaXBlbGluZT8ucmVzZXQobmVhcmVzdEtleWZyYW1lKTsKCiAgY29uc3QgZ29wRnJhbWVDb3VudCA9IGdvcExlbmd0aEZyb21LZXlmcmFtZShib290c3RyYXAuaW5kZXhTZWdtZW50cywgQmlnSW50KG5lYXJlc3RLZXlmcmFtZSkpOwogIHBvc3QoeyB0eXBlOiAnc2Vla2VkJywgbmVhcmVzdEtleWZyYW1lRWRpdFVuaXQ6IG5lYXJlc3RLZXlmcmFtZSwgZ29wRnJhbWVDb3VudCB9KTsKfQoKLyoqCiAqIEZhc3QtZHJhZyBzY3J1YiBwcmV2aWV3IGluIGEgc2luZ2xlIHJvdW5kLXRyaXA6IHJlc29sdmUgdGhlIEdPUC1oZWFkIGtleWZyYW1lIGZvciBgdGFyZ2V0RnJhbWVgLAogKiByZXNldCB0aGUgZGVjb2RlciB0aGVyZSAoc3VwZXJzZWRpbmcgYW55IGluLWZsaWdodCB3b3JrKSwgdGhlbiBlbnF1ZXVlIGEgb25lLWZyYW1lIGRlY29kZSB3aG9zZQogKiBzYW1wbGUgaXMgc3RyZXRjaGVkIHRvIHNwYW4gdGhlIEdPUC4gUmVwbGllcyB3aXRoIGBwcmV2aWV3RG9uZXtzZXF9YCAoYWx3YXlzIOKAlCBzZWUgdGhlIGZpbmFsbHkgaW4KICogaGFuZGxlRmV0Y2hTZWdtZW50KSBzbyB0aGUgcGxheWVyJ3Mgc2luZ2xlLWZsaWdodCBwdW1wIGNhbiBhZHZhbmNlIHRvIHRoZSBsYXRlc3QgZHJhZ2dlZCBwb3NpdGlvbi4KICogRm9sZGluZyB0aGUgc2VlayArIGZldGNoIGludG8gb25lIGNvbW1hbmQgaGFsdmVzIG1lc3NhZ2UgbGF0ZW5jeSB2ZXJzdXMgc2Vla+KGknNlZWtlZOKGkmZldGNoLCB3aGljaAogKiBtYXR0ZXJzIHdoaWxlIGRyYWdnaW5nLgogKi8KZnVuY3Rpb24gaGFuZGxlU2NydWJQcmV2aWV3KHRhcmdldEZyYW1lOiBudW1iZXIsIHNlcTogbnVtYmVyKTogdm9pZCB7CiAgaWYgKCFteGZGaWxlKSB7IHBvc3QoeyB0eXBlOiAncHJldmlld0RvbmUnLCBzZXEsIGVkaXRVbml0OiB0YXJnZXRGcmFtZSB9KTsgcmV0dXJuOyB9CiAgY29uc3QgYm9vdHN0cmFwID0gbXhmRmlsZS5nZXRCb290c3RyYXAoKTsKICBpZiAoIWJvb3RzdHJhcCkgeyBwb3N0KHsgdHlwZTogJ3ByZXZpZXdEb25lJywgc2VxLCBlZGl0VW5pdDogdGFyZ2V0RnJhbWUgfSk7IHJldHVybjsgfQoKICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVGcmFtZU9mZnNldCgKICAgIGJvb3RzdHJhcC5pbmRleFNlZ21lbnRzLAogICAgQmlnSW50KHRhcmdldEZyYW1lKSwKICAgIGJvb3RzdHJhcC5lc3NlbmNlU3RhcnQsCiAgICBib290c3RyYXAuZXNzZW5jZUJvZHlTSUQsCiAgKTsKICBjb25zdCBrZXlmcmFtZSA9IHJlc29sdmVkID8gTnVtYmVyKHJlc29sdmVkLm5lYXJlc3RLZXlmcmFtZUVkaXRVbml0KSA6IHRhcmdldEZyYW1lOwoKICAvLyBDYWNoZSBoaXQ6IHRoaXMgR09QIGhlYWQgd2FzIGFscmVhZHkgZGVjb2RlZCtlbmNvZGVkIHRoaXMgc2Vzc2lvbiDigJQgcmUtc2VydmUgaXRzIHNlZ21lbnQKICAvLyB2ZXJiYXRpbSB3aXRoIG5vIGRlY29kZS9lbmNvZGUgKGFuZCB3aXRob3V0IGRpc3R1cmJpbmcgdGhlIGRlY29kZXIgc3RhdGUpLiBEcmFnZ2luZyB3aXRoaW4gYQogIC8vIEdPUCwgb3IgYmFjayBvdmVyIGEgdmlzaXRlZCByZWdpb24sIGJlY29tZXMgaW5zdGFudC4gUG9zdCBhIGZyZXNoIGNvcHkgc2luY2UgdGhlIGJ1ZmZlciBpcwogIC8vIHRyYW5zZmVycmVkIHRvIHRoZSBtYWluIHRocmVhZC4KICBjb25zdCBjYWNoZWQgPSBzY3J1YlNlZ21lbnRDYWNoZS5nZXQoa2V5ZnJhbWUpOwogIGlmIChjYWNoZWQpIHsKICAgIGNvbnN0IGNvcHkgPSBjYWNoZWQuc2xpY2UoKTsKICAgIHBvc3QoeyB0eXBlOiAndmlkZW9TZWdtZW50JywgZGF0YTogY29weS5idWZmZXIgYXMgQXJyYXlCdWZmZXIsIHNlcTogc2NydWJTZXFCYXNlLCBlZGl0VW5pdDoga2V5ZnJhbWUgfSwgW2NvcHkuYnVmZmVyXSk7CiAgICBzY3J1YlNlcUJhc2UgKz0gMjsKICAgIHBvc3QoeyB0eXBlOiAncHJldmlld0RvbmUnLCBzZXEsIGVkaXRVbml0OiBrZXlmcmFtZSB9KTsKICAgIHJldHVybjsKICB9CgogIC8vIEZldGNoIGEgc21hbGwgQ09OVElHVU9VUyBydW4gb2YgcmVhbCBmcmFtZXMgc3RhcnRpbmcgQVQgdGhlIGtleWZyYW1lICh0aGUgcGxheWVyIHJlbmRlcnMgdGhlCiAgLy8ga2V5ZnJhbWUsIG5vdCB0aGUgbWlkLUdPUCB0YXJnZXQg4oCUIHN0YW5kYXJkIGtleWZyYW1lLWdyYW51bGFyaXR5IHNjcnViKS4gQSBwYXVzZWQgPHZpZGVvPiBwYWludHMKICAvLyBhIHNlZWsgaW50byBhIGNvbnRpZ3VvdXMgbXVsdGktZnJhbWUgcmVnaW9uIChleGFjdGx5IHdoeSBzY3J1YmJpbmcgdGhlIGFscmVhZHktYnVmZmVyZWQgYXJlYQogIC8vIHdvcmtzKSBidXQgd2lsbCBOT1Qgc2V0dGxlIG9uIGEgbG9uZSBzdHJldGNoZWQgc2FtcGxlLiB+MC40IHMgb2YgbG9va2FoZWFkIGlzIGVub3VnaCBjb250aWd1b3VzCiAgLy8gZnV0dXJlIGRhdGEgdG8gcGFpbnQsIHdoaWxlIGtlZXBpbmcgdGhlIHBlci1wcmV2aWV3IGRlY29kZSBzbWFsbCDigJQgY3JpdGljYWwgZm9yIE1QRUctMiwgd2hlcmUKICAvLyBkZWNvZGluZyBhIHdob2xlIEdPUCtsb29rYWhlYWQgcGVyIHByZXZpZXcgc2F0dXJhdGVkIHRoZSB3b3JrZXIgc28gbm90aGluZyBwYWludGVkLiBDb25zdGFudCBwZXIKICAvLyBrZXlmcmFtZSAoaW5kZXBlbmRlbnQgb2YgdGFyZ2V0KSBzbyBpdCBzdGF5cyBjYWNoZWFibGUuCiAgY29uc3QgZnBzID0gc3RvcmVkRWRpdFJhdGVOdW1lcmF0b3IgLyBzdG9yZWRFZGl0UmF0ZURlbm9taW5hdG9yOwogIGNvbnN0IHJ1bkZyYW1lcyA9IDEgKyBNYXRoLm1heChTQ1JVQl9QUkVWSUVXX01JTl9MT09LQUhFQURfRlJBTUVTLCBNYXRoLnJvdW5kKGZwcyAqIFNDUlVCX1BSRVZJRVdfTE9PS0FIRUFEX1NFQ09ORFMpKTsKCiAgLy8gU2VlayBwYXJ0IChtaXJyb3JzIGhhbmRsZVNlZWspOiBzdXBlcnNlZGUgaW4tZmxpZ2h0IHdvcmsgYW5kIHJlc2V0IHRoZSBkZWNvZGVyIHRvIHRoZSBrZXlmcmFtZS4KICBmZXRjaFEuc3VwZXJzZWRlKCk7CiAgbXBlZzJQaXBlbGluZT8ucmVzZXQoa2V5ZnJhbWUpOwoKICAvLyBFbnF1ZXVlIHRoZSB0aHJvd2F3YXkgZGVjb2RlIChzZXJpYWxpemVkIHZpYSB0aGUgcXVldWUgc28gaXQgY2FuJ3QgcmFjZSBhIG5vcm1hbCBmZXRjaCkuCiAgLy8gc3RyZXRjaFRvRnJhbWVzIHN0YXlzIDAg4oCUIHRoZXNlIGFyZSByZWFsIGNvbnNlY3V0aXZlIGZyYW1lcywgc28gdGhlIHNlZ21lbnQgaXMgbmF0dXJhbGx5CiAgLy8gY29udGlndW91cyBhbmQgdGhlIGVsZW1lbnQgY2FuIHBhaW50IGEgcGF1c2VkIHNlZWsgaW50byBpdC4KICBmZXRjaFEuZW5xdWV1ZSh7IHN0YXJ0RnJhbWU6IGtleWZyYW1lLCBmcmFtZUNvdW50OiBydW5GcmFtZXMsIHNlcUJhc2U6IHNjcnViU2VxQmFzZSwgcHJldmlld1NlcTogc2VxIH0pOwogIHNjcnViU2VxQmFzZSArPSAyOwp9CgovLyBDb21tYW5kIGRpc3BhdGNoOiBvbmUgaGFuZGxlciBwZXIgY29tbWFuZCB0eXBlLiBFYWNoIGhhbmRsZXIncyBwYXJhbWV0ZXIgaXMgbmFycm93ZWQgdG8gdGhlCi8vIG1hdGNoaW5nIG1lbWJlciBvZiB0aGUgV29ya2VyQ29tbWFuZCB1bmlvbiwgc28gYWRkaW5nIGEgY29tbWFuZCBpcyBhIHNpbmdsZSBlbnRyeSBoZXJlIChwbHVzIHRoZQovLyB1bmlvbiBpdHNlbGYpIHJhdGhlciB0aGFuIGEgbmV3IHN3aXRjaCBjYXNlLiBUaGUgZGlzcGF0Y2ggY2FzdCBpcyB0aGUgc3RhbmRhcmQgZGlzY3JpbWluYXRlZC11bmlvbgovLyBtYXAgaWRpb20g4oCUIHRoZSBsb29rdXAgcGlja3MgdGhlIHJpZ2h0IGhhbmRsZXIgYnkgY21kLnR5cGUgYmVmb3JlIHRoZSBjYWxsLgp0eXBlIENvbW1hbmRIYW5kbGVycyA9IHsgW0sgaW4gV29ya2VyQ29tbWFuZFsndHlwZSddXTogKGNtZDogRXh0cmFjdDxXb3JrZXJDb21tYW5kLCB7IHR5cGU6IEsgfT4pID0+IHZvaWQgfTsKCmNvbnN0IGNvbW1hbmRIYW5kbGVyczogQ29tbWFuZEhhbmRsZXJzID0gewogIGluaXRVcmw6IChjbWQpID0+IHsKICAgIHZpZGVvTW9kZSA9IGNtZC52aWRlb01vZGUgPz8gJ21zZSc7CiAgICBoYW5kbGVJbml0KG5ldyBIdHRwTG9hZGVyKGNtZC51cmwpLCBjbWQuZGVidWcpLmNhdGNoKGUgPT4gcG9zdEVycm9yKFN0cmluZyhlKSwgdHJ1ZSkpOwogIH0sCiAgaW5pdEZpbGU6IChjbWQpID0+IHsKICAgIHZpZGVvTW9kZSA9IGNtZC52aWRlb01vZGUgPz8gJ21zZSc7CiAgICBoYW5kbGVJbml0KG5ldyBGaWxlTG9hZGVyKGNtZC5maWxlKSwgY21kLmRlYnVnKS5jYXRjaChlID0+IHBvc3RFcnJvcihTdHJpbmcoZSksIHRydWUpKTsKICB9LAogIGZldGNoU2VnbWVudDogKGNtZCkgPT4gewogICAgZmV0Y2hRLmVucXVldWUoewogICAgICBzdGFydEZyYW1lOiBjbWQuc3RhcnRGcmFtZSwKICAgICAgZnJhbWVDb3VudDogY21kLmZyYW1lQ291bnQsCiAgICAgIHNlcUJhc2U6IGNtZC5zZXFCYXNlLAogICAgICBzdHJldGNoVG9GcmFtZXM6IGNtZC5zdHJldGNoVG9GcmFtZXMgPz8gMCwKICAgIH0pOwogIH0sCiAgc2VlazogKGNtZCkgPT4gaGFuZGxlU2VlayhjbWQudGFyZ2V0RnJhbWUpLAogIHNjcnViUHJldmlldzogKGNtZCkgPT4gaGFuZGxlU2NydWJQcmV2aWV3KGNtZC50YXJnZXRGcmFtZSwgY21kLnNlcSksCiAgLy8gU2NydWIgc3RhcnRlZDogZHJvcCBpbi1mbGlnaHQvcXVldWVkIGZvcndhcmQgcHJlZmV0Y2ggc28gdGhlIHdvcmtlciBpcyBmcmVlIGZvciBwcmV2aWV3cy4gVGhlCiAgLy8gaW4tZmxpZ2h0IHRyYW5zY29kZSBjaGVja3MgdGhlIGdlbmVyYXRpb24gYWZ0ZXIgZWFjaCBmcmFtZSBhbmQgYmFpbHM7IHF1ZXVlZCBqb2JzIGFyZSBjbGVhcmVkLgogIGNhbmNlbFByZWZldGNoOiAoKSA9PiB7IGZldGNoUS5zdXBlcnNlZGUoKTsgfSwKfTsKCnNlbGYuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIChldmVudDogTWVzc2FnZUV2ZW50PFdvcmtlckNvbW1hbmQ+KSA9PiB7CiAgY29uc3QgY21kID0gZXZlbnQuZGF0YTsKICAoY29tbWFuZEhhbmRsZXJzW2NtZC50eXBlXSBhcyAoYzogV29ya2VyQ29tbWFuZCkgPT4gdm9pZCkoY21kKTsKfSk7Cg==", import.meta.url);
    return new Worker(g, { type: "module" });
  }
  async onWorkerMessage(g) {
    var t, e, I, c;
    switch (g.type) {
      case "manifest":
        await this.onManifest(g);
        break;
      case "initSegment":
        (t = this.mseController) != null && t.hasVideoBuffer() || (e = this.mseController) != null && e.hasAudioBuffer() ? (this.mseController.appendSegment("video", g.data), this.mseController.appendSegment("audio", g.data), this.fetchNextChunk()) : this.pendingInitSegment = g.data;
        break;
      case "videoSegment":
        (I = this.mseController) == null || I.appendSegment("video", g.data);
        break;
      case "audioSegment":
        (c = this.mseController) == null || c.appendSegment("audio", g.data);
        break;
      case "pcmSamples":
        this.emit("pcm-audio", {
          samples: g.samples,
          sampleRate: g.sampleRate,
          channelCount: g.channelCount,
          editUnit: g.editUnit
        }), this.audio.schedule(g.samples, g.sampleRate, g.channelCount, g.editUnit);
        break;
      case "segmentDone":
        this.fetchPending = !1, this.fetchNextChunk();
        break;
      case "seeked": {
        if (this.pendingSeeks = Math.max(0, this.pendingSeeks - 1), this.pendingSeeks > 0) break;
        const l = g.nearestKeyframeEditUnit;
        if (this.nextFetchFrame = l, this.fetchPending = !1, this.activeSeekMode === "keyframe") {
          const Z = Math.max(g.gopFrameCount, this.seekTargetFrame - l + 1, 1);
          this.fetchKeyframePreview(l, Z);
          break;
        }
        const i = Math.min(
          this.framesPerChunk,
          Math.max(1, this.seekTargetFrame - l + 3)
        );
        this.fetchNextChunk(i);
        break;
      }
      case "previewDone":
        this.scrub.onPreviewDone(g.editUnit);
        break;
      case "codecUnsupported":
        this.emit("codec-unsupported", { codec: g.codec, reason: g.reason });
        break;
      case "error":
        this.emit("error", { message: g.message, fatal: g.fatal });
        break;
    }
  }
  async onManifest(g) {
    var Z, s;
    const t = g.pictureDescriptor, e = g.soundDescriptor;
    this.editRateNumerator = g.editRateNumerator, this.editRateDenominator = g.editRateDenominator, this.audio.setEditRate(g.editRateNumerator, g.editRateDenominator), this.scrub.setStream(g.duration, g.editRateNumerator, g.editRateDenominator);
    const I = g.editRateNumerator / g.editRateDenominator;
    this.framesPerChunk = Math.ceil(I * y), this.manifest = {
      duration: g.duration,
      editRateNumerator: g.editRateNumerator,
      editRateDenominator: g.editRateDenominator,
      tracks: g.tracks,
      pictureDescriptor: t,
      soundDescriptor: e,
      indexMode: g.indexMode
    };
    const c = g.resolvedVideoCodec ?? (t == null ? void 0 : t.codec) ?? "unknown", l = t && g.videoCodecSupported ? b.getMimeType("video", c) : null;
    let i = e ? b.getMimeType("audio", e.codec) : null;
    (e == null ? void 0 : e.codec) === "pcm" && (this.config.pcmAudioMode === "webaudio" || !i) && (i = null, this.audio.createContext(e.sampleRate)), this.audio.applyChannelCount(g.audioChannelCount);
    try {
      await this.mseController.open(l, i);
    } catch (n) {
      this.emit("error", { message: `MSE open failed: ${n}`, fatal: !0 });
      return;
    }
    this.mseController.setDuration(g.duration), this.pendingInitSegment ? ((Z = this.mseController) == null || Z.appendSegment("video", this.pendingInitSegment), (s = this.mseController) == null || s.appendSegment("audio", this.pendingInitSegment), this.pendingInitSegment = null, this.emit("manifest", this.manifest), this.log(`Manifest: ${g.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${e == null ? void 0 : e.codec}`), this.fetchNextChunk()) : (this.emit("manifest", this.manifest), this.log(`Manifest: ${g.duration.toFixed(2)}s, video=${t == null ? void 0 : t.codec}, audio=${e == null ? void 0 : e.codec}`));
  }
  /**
   * Fetch a single I-frame at `keyframe` for a fast scrub preview, telling the worker to stretch
   * that one decoded sample across `stretchFrames` frame periods so it covers its whole GOP on the
   * MSE timeline. Posted directly (not via fetchNextChunk) so it isn't gated by the scrub guard.
   */
  fetchKeyframePreview(g, t) {
    if (!this.manifest) return;
    this.previewParked = !0, this.nextFetchFrame = g;
    const e = {
      type: "fetchSegment",
      startFrame: g,
      frameCount: 1,
      seqBase: this.seqBase,
      stretchToFrames: t
    };
    this.seqBase += 2, this.worker.postMessage(e);
  }
  fetchNextChunk(g = this.framesPerChunk) {
    var i;
    if (this.scrub.isActive || this.previewParked || this.bufferFull || this.fetchPending || !this.manifest) return;
    const t = this.video.currentTime, e = this.editRateNumerator / this.editRateDenominator;
    if (this.nextFetchFrame / e - t >= this.config.maxBufferSeconds) return;
    const c = Math.round(
      this.manifest.duration * this.editRateNumerator / this.editRateDenominator
    );
    if (this.nextFetchFrame >= c) {
      (i = this.mseController) == null || i.endOfStream();
      return;
    }
    this.fetchPending = !0;
    const l = {
      type: "fetchSegment",
      startFrame: this.nextFetchFrame,
      frameCount: g,
      seqBase: this.seqBase
    };
    this.seqBase += 2, this.nextFetchFrame += g, this.worker.postMessage(l);
  }
  onVideoSeeking() {
    if (!this.manifest || this.scrub.consumeSuppressedSeeking()) return;
    const g = this.video.currentTime;
    if (this.emit("seeking", { targetTime: g }), this.scrub.isActive) {
      this.scrub.scrubTo(g);
      return;
    }
    this.initiateSeek(g, this.config.seekMode);
  }
  onVideoSeeked() {
    this.scrub.onVideoSeeked();
  }
  initiateSeek(g, t) {
    if (!this.manifest) return;
    this.fetchPending = !0, this.activeSeekMode = t, this.previewParked = !1, this.bufferFull = !1, this.seekTargetFrame = Math.round(
      g * this.editRateNumerator / this.editRateDenominator
    ), this.pendingSeeks++, this.audio.flush(), this.audio.resetAnchor();
    const e = { type: "seek", targetFrame: this.seekTargetFrame };
    this.worker.postMessage(e);
  }
  onTimeUpdate() {
    var e, I;
    if (!this.manifest) return;
    const g = this.video.currentTime;
    this.scrub.isActive || ((e = this.mseController) == null || e.trimBackBuffer(g), this.bufferFull = !1);
    const t = ((I = this.mseController) == null ? void 0 : I.getBufferedAhead("video", g)) ?? 0;
    t < this.config.startBufferSeconds && (this.previewParked && !this.video.paused && !this.scrub.isActive ? this.initiateSeek(g, "accurate") : this.fetchNextChunk()), this.emit("buffering", { bufferedSeconds: t }), this.emit("timeupdate", { currentTime: g, duration: this.duration });
  }
  log(g) {
    this.config.debug && console.log("[mxf.js]", g);
  }
  destroyInternal() {
    var g, t;
    (g = this.worker) == null || g.terminate(), this.worker = null, (t = this.mseController) == null || t.destroy(), this.mseController = null, this.audio.destroy(), this.manifest = null, this.nextFetchFrame = 0, this.fetchPending = !1, this.bufferFull = !1, this.seqBase = 0, this.pendingInitSegment = null, this.pendingSeeks = 0, this.seekTargetFrame = 0, this.activeSeekMode = "accurate", this.previewParked = !1, this.scrub.reset();
  }
  destroy() {
    this.destroyInternal(), this.removeAllListeners(), this.emit("destroyed", void 0);
  }
}
export {
  p as MxfPlayer
};
//# sourceMappingURL=mxf.esm.js.map
