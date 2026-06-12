/**
 * Minimal HLS (RFC 8216) m3u8 parser — only the handful of tags the playlist player needs.
 *
 * Each media segment URI is treated as a complete MXF clip. We extract just enough to drive
 * seamless clip-playlist playback:
 *  - the ordered segment list (URIs resolved to absolute against the manifest URL, + EXTINF duration)
 *  - whether the playlist is finished (`#EXT-X-ENDLIST` → static/VOD vs live)
 *  - the media-sequence base (`#EXT-X-MEDIA-SEQUENCE`) so a polled live playlist can be deduped
 *  - the target duration (`#EXT-X-TARGETDURATION`) as a poll-interval hint
 *
 * Master playlists (variant streams via `#EXT-X-STREAM-INF`) are NOT handled — these are expected to
 * be media playlists of MXF clips. Encryption, byte-range, discontinuity and date-range tags are
 * ignored (the clips are independent whole files).
 */

export interface HlsSegment {
  /** Absolute URI of the clip (resolved against the manifest URL). */
  uri: string;
  /** EXTINF duration in seconds (0 if the segment had no EXTINF, which is non-conformant). */
  durationSec: number;
}

export interface HlsPlaylist {
  segments: HlsSegment[];
  /** True when `#EXT-X-ENDLIST` is present — the playlist is static/VOD and will not change. */
  endList: boolean;
  /** `#EXT-X-MEDIA-SEQUENCE` value (sequence number of the first segment); defaults to 0. */
  mediaSequence: number;
  /** `#EXT-X-TARGETDURATION` in seconds (poll-interval hint); 0 if absent. */
  targetDuration: number;
}

/**
 * Parse a media-playlist m3u8. `manifestUrl` is used to resolve relative segment URIs to absolute.
 * Lenient by design: unknown tags are skipped, and a missing `#EXTM3U` header is tolerated (some
 * servers omit it) rather than throwing, so a transient bad poll doesn't kill live playback.
 */
export function parseHlsPlaylist(text: string, manifestUrl: string): HlsPlaylist {
  const segments: HlsSegment[] = [];
  let endList = false;
  let mediaSequence = 0;
  let targetDuration = 0;
  let pendingDuration = 0; // EXTINF value awaiting its URI line

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) {
        // #EXTINF:<duration>,[<title>]
        const v = line.slice('#EXTINF:'.length).split(',')[0];
        const d = parseFloat(v);
        pendingDuration = Number.isFinite(d) ? d : 0;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        const d = parseInt(line.slice('#EXT-X-TARGETDURATION:'.length), 10);
        if (Number.isFinite(d)) targetDuration = d;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const n = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
        if (Number.isFinite(n)) mediaSequence = n;
      } else if (line === '#EXT-X-ENDLIST') {
        endList = true;
      }
      // All other tags (incl. #EXTM3U, #EXT-X-VERSION, comments) are ignored.
      continue;
    }

    // A non-tag, non-empty line is a segment URI; it consumes the most recent EXTINF.
    segments.push({ uri: resolveUri(line, manifestUrl), durationSec: pendingDuration });
    pendingDuration = 0;
  }

  return { segments, endList, mediaSequence, targetDuration };
}

/** Resolve a (possibly relative) segment URI against the manifest URL. Falls back to the raw value
 *  if URL resolution fails (e.g. a non-URL base in a test harness). */
function resolveUri(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}
