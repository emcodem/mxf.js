import { EventEmitter } from '../events.js';
import { parseHlsPlaylist } from './hls-parser.js';

/** A clip surfaced by the playlist, in playback order. `seq` is the absolute HLS media-sequence
 *  number (mediaSequence + index), used to dedupe across live re-polls. */
export interface PlaylistClip {
  url: string;
  durationSec: number;
  seq: number;
}

export interface PlaylistControllerEvents {
  /** New clips appended (initial load + each live poll that reveals more). Ordered, contiguous. */
  'clips-added': { clips: PlaylistClip[] };
  /** The playlist is static (had, or grew, an `#EXT-X-ENDLIST`): no more clips will be added.
   *  `totalClips` is the final count. The player can now show a full spanning timeline. */
  'static-known': { totalClips: number };
  /** A fatal error (the initial fetch/parse failed) or a non-fatal one (a live poll blipped). */
  error: { message: string; fatal: boolean };
}

/** Lower bound for the live poll interval, regardless of TARGETDURATION (avoid hammering). */
const MIN_POLL_SECONDS = 1;
/** Fallback poll interval when TARGETDURATION is absent. */
const DEFAULT_POLL_SECONDS = 3;

/**
 * Owns the m3u8 lifecycle for playlist mode. Fetches and parses the manifest, distinguishes static
 * (VOD, `#EXT-X-ENDLIST`) from live (polled), and emits clips in playback order — deduped by absolute
 * media-sequence number so a polled live playlist never re-emits a clip. Knows nothing about frames,
 * offsets or the worker; the player maps clips onto the global timeline.
 */
export class PlaylistController extends EventEmitter<PlaylistControllerEvents> {
  private readonly manifestUrl: string;
  /** Highest absolute media-sequence number already emitted (-1 = none yet). */
  private lastSeq = -1;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollSeconds = DEFAULT_POLL_SECONDS;
  private stopped = false;
  private totalEmitted = 0;

  constructor(manifestUrl: string) {
    super();
    this.manifestUrl = manifestUrl;
  }

  /** Begin: fetch the manifest once, emit its clips, and (if live) start polling. */
  async start(): Promise<void> {
    let first: Awaited<ReturnType<typeof this.fetchAndParse>>;
    try {
      first = await this.fetchAndParse();
    } catch (e) {
      this.emit('error', { message: `Playlist fetch failed: ${this.errMsg(e)}`, fatal: true });
      return;
    }
    if (this.stopped) return;

    this.applyPlaylist(first);

    if (first.endList) {
      this.emit('static-known', { totalClips: this.totalEmitted });
      return;
    }
    // Live: keep polling for appended clips / a future ENDLIST.
    this.scheduleNextPoll();
  }

  /** Stop polling and release resources. */
  destroy(): void {
    this.stopped = true;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------

  private async fetchAndParse() {
    const res = await fetch(this.manifestUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    return parseHlsPlaylist(text, this.manifestUrl);
  }

  /** Emit any not-yet-seen clips from a parsed playlist and update poll cadence. */
  private applyPlaylist(pl: ReturnType<typeof parseHlsPlaylist>): void {
    if (pl.targetDuration > 0) {
      this.pollSeconds = Math.max(MIN_POLL_SECONDS, pl.targetDuration);
    }
    const fresh: PlaylistClip[] = [];
    pl.segments.forEach((seg, i) => {
      const seq = pl.mediaSequence + i;
      if (seq <= this.lastSeq) return; // already emitted (live sliding window overlap)
      fresh.push({ url: seg.uri, durationSec: seg.durationSec, seq });
      this.lastSeq = seq;
    });
    if (fresh.length > 0) {
      this.totalEmitted += fresh.length;
      this.emit('clips-added', { clips: fresh });
    }
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => { void this.poll(); }, this.pollSeconds * 1000);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const pl = await this.fetchAndParse();
      if (this.stopped) return;
      this.applyPlaylist(pl);
      if (pl.endList) {
        this.emit('static-known', { totalClips: this.totalEmitted });
        return; // stop polling — the playlist is now final
      }
    } catch (e) {
      // A live poll blip is non-fatal: log and keep polling so a transient network/server error
      // doesn't end the session.
      this.emit('error', { message: `Playlist poll failed: ${this.errMsg(e)}`, fatal: false });
    }
    this.scheduleNextPoll();
  }

  private errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
