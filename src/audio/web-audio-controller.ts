/**
 * Web Audio PCM scheduling, extracted from MxfPlayer.
 *
 * MSE generally cannot play raw PCM, so the worker decodes it to interleaved Float32 and posts it
 * here. This controller mixes the file's channels down to a stereo output and schedules each chunk
 * on the AudioContext clock, anchored to the <video> playhead so audio stays locked to the picture
 * across (re)starts and seeks. It also owns channel-selection state so a re-selection can re-mix and
 * reschedule the not-yet-heard audio immediately (near-instant switch).
 *
 * The single render/clock surface remains the <video> element; this controller only reads its
 * currentTime to anchor the audio timeline.
 */

interface ScheduledChunk {
  source: AudioBufferSourceNode | null;
  bufStartContextTime: number; // AudioContext time this chunk's first sample should sound
  duration: number;            // seconds
  samples: Float32Array;       // interleaved source samples (all channels)
  channelCount: number;
  sampleRate: number;
}

export class WebAudioController {
  private cxt: AudioContext | null = null;
  // Anchor mapping presentation time 0 → AudioContext time. Reset on seek so the next chunk re-locks
  // to the new playhead instead of sounding at the pre-seek offset.
  private startTime: number | null = null;
  // Total PCM channels in the file (0 until the first chunk / manifest count arrives).
  private channelCount = 0;
  // Source channels (0-based) currently routed to the stereo output. Default: first pair (1+2).
  private active: number[] = [0, 1];
  // Scheduled (playing/future) chunks, retained with raw samples so a re-selection can re-mix them.
  private scheduled: ScheduledChunk[] = [];
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
   * Applies to already-buffered audio so the change is near-instant.
   */
  setActiveChannels(channels: number[]): void {
    this.active = [...new Set(channels.filter(c => Number.isInteger(c) && c >= 0))].sort((a, b) => a - b);
    this.rescheduleActive();
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
   * Schedule a decoded interleaved PCM chunk. Anchors the audio timeline to the <video> playhead on
   * the first chunk after a (re)start/seek so audio locks to the displayed frame.
   */
  schedule(samples: Float32Array, sampleRate: number, channelCount: number, editUnit: number): void {
    if (!this.cxt) return;
    const cxt = this.cxt;

    this.applyChannelCount(channelCount);

    const samplesPerChannel = Math.floor(samples.length / channelCount);
    const presTime = editUnit * this.editRateDenominator / this.editRateNumerator;
    const duration = samplesPerChannel / sampleRate;

    // audioStartTime maps presentation time → AudioContext time; re-anchoring on (re)start keeps
    // audio locked to the frame the <video> is showing. Reset on every seek (resetAnchor).
    if (this.startTime === null) this.startTime = cxt.currentTime - this.video.currentTime;

    const entry: ScheduledChunk = {
      source: null,
      bufStartContextTime: this.startTime + presTime,
      duration, samples, channelCount, sampleRate,
    };
    if (this.scheduleEntry(entry)) this.scheduled.push(entry);
  }

  /** Drop the playhead anchor so the next chunk re-locks to the (new) playhead. Call on seek. */
  resetAnchor(): void {
    this.startTime = null;
  }

  /** Stop and clear all scheduled audio (e.g. on seek, so nothing keeps playing at the old offset). */
  flush(): void {
    for (const e of this.scheduled) {
      try { if (e.source) { e.source.onended = null; e.source.stop(); } } catch { /* already stopped */ }
    }
    this.scheduled = [];
  }

  /** Flush and tear down the AudioContext; reset channel state for the next file. */
  destroy(): void {
    this.flush();
    this.cxt?.close().catch(() => {});
    this.cxt = null;
    this.startTime = null;
    this.channelCount = 0; // re-announced on the next file's first chunk
  }

  /**
   * Mix an interleaved buffer's currently-active channels to stereo and start it at the right point
   * on the AudioContext clock. Audio whose window lies entirely before the playhead is dropped (this
   * skips the keyframe→target frames an accurate seek decodes for the picture but which precede the
   * displayed frame); a chunk straddling the playhead starts partway in. Returns false if nothing was
   * scheduled. Mixing explicitly is more reliable than Web Audio's implicit down-mix (undefined for
   * >6/non-standard channel counts).
   */
  private scheduleEntry(entry: ScheduledChunk): boolean {
    const cxt = this.cxt!;
    const now = cxt.currentTime;
    const into = now - entry.bufStartContextTime; // seconds already elapsed into this chunk
    if (into >= entry.duration - 0.001) return false; // entirely before the playhead — drop it

    const { samples, channelCount, sampleRate } = entry;
    const samplesPerChannel = Math.floor(samples.length / channelCount);
    const sel = this.active.filter(c => c < channelCount);
    const left: number[] = [], right: number[] = [];
    sel.forEach((c, i) => (i % 2 === 0 ? left : right).push(c));
    if (sel.length === 1) { right.length = 0; right.push(sel[0]); } // single channel → centre

    const buffer = cxt.createBuffer(2, samplesPerChannel, sampleRate);
    const mixInto = (out: Float32Array, chans: number[]): void => {
      if (chans.length === 0) return;
      const gain = 1 / chans.length;
      for (let i = 0; i < samplesPerChannel; i++) {
        let acc = 0;
        const base = i * channelCount;
        for (const c of chans) acc += samples[base + c];
        out[i] = acc * gain;
      }
    };
    mixInto(buffer.getChannelData(0), left);
    mixInto(buffer.getChannelData(1), right);

    const source = cxt.createBufferSource();
    source.buffer = buffer;
    source.connect(cxt.destination);
    if (into <= 0) source.start(entry.bufStartContextTime);   // future chunk: start at its time
    else source.start(now, into);                              // live chunk: start now, offset in
    source.onended = () => { const i = this.scheduled.indexOf(entry); if (i >= 0) this.scheduled.splice(i, 1); };
    entry.source = source;
    return true;
  }

  /**
   * Re-mix and reschedule all still-playing / future audio with the current channel selection, so a
   * change takes effect (near-)immediately instead of only on the next decoded chunk.
   */
  private rescheduleActive(): void {
    if (!this.cxt) return;
    const keep: ScheduledChunk[] = [];
    for (const e of this.scheduled) {
      try { if (e.source) { e.source.onended = null; e.source.stop(); } } catch { /* already stopped */ }
      e.source = null;
      if (this.scheduleEntry(e)) keep.push(e);
    }
    this.scheduled = keep;
  }
}
