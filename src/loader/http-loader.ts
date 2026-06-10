import { ILoader, logRead } from './loader.js';

/** Total attempts for a single range read before giving up (1 initial try + retries). */
const FETCH_RETRIES = 3;
/** Backoff before each retry, in ms; the last value is reused for any further attempts. */
const BACKOFF_MS = [120, 350];

/**
 * Error message shown when the server returns 200 instead of 206 for a Range request — i.e. it
 * ignored the Range header and would send the WHOLE file for every read. Streaming MXF requires
 * real byte-range support.
 */
function noRangeError(url: string): Error {
  return new Error(
    `${url}: the server ignored the Range request (responded 200, not 206 Partial Content). ` +
    `It does not support byte-range requests, which mxf.js needs to stream without downloading the ` +
    `entire file. Use a range-capable static server — e.g. \`npx http-server --cors\`, nginx, or ` +
    `caddy. Python's \`http.server\` does NOT support ranges.`,
  );
}

export class HttpLoader implements ILoader {
  private readonly url: string;
  readonly fileSize: Promise<number>;
  /** Controllers for in-flight reads, so destroy() can abort them all (teardown / new file). */
  private readonly inflight = new Set<AbortController>();
  private readStats = { count: 0, total: 0 };

  constructor(url: string) {
    this.url = url;
    this.fileSize = this.fetchFileSize();
  }

  private async fetchFileSize(): Promise<number> {
    // Get the size from HEAD if possible...
    let size = NaN;
    try {
      const head = await fetch(this.url, { method: 'HEAD' });
      if (head.ok) {
        const len = head.headers.get('content-length');
        if (len) size = parseInt(len, 10);
      }
    } catch {
      // HEAD blocked/unsupported — fall through to the range probe.
    }

    // ...but ALWAYS probe with a 1-byte range to verify the server honours ranges BEFORE we start
    // streaming. A non-range server would otherwise return the full file on the first real read.
    let res: Response;
    try {
      res = await fetch(this.url, { headers: { Range: 'bytes=0-0' } });
    } catch (e) {
      throw new Error(
        `Cannot fetch ${this.url}: ${e instanceof Error ? e.message : String(e)}. ` +
        `If the file is on a different origin, the server must send CORS headers ` +
        `(Access-Control-Allow-Origin) and allow Range requests.`,
      );
    }
    // Read headers first, then discard the body so a mis-behaving 200 doesn't download the whole file.
    const contentRange = res.headers.get('content-range');
    const contentLength = res.headers.get('content-length');
    try { await res.body?.cancel(); } catch { /* ignore */ }

    if (res.status === 200) throw noRangeError(this.url);
    if (res.status !== 206) throw new Error(`Range probe of ${this.url} failed: ${res.status} ${res.statusText}`);

    // Content-Range: "bytes 0-0/123456" — the part after '/' is the total size.
    const total = contentRange?.split('/')[1];
    if (total && total !== '*') return parseInt(total, 10);
    if (!Number.isNaN(size)) return size;
    if (contentLength) return parseInt(contentLength, 10); // last resort (1 for a 0-0 range)
    throw new Error(`Server did not report a size for ${this.url} (no Content-Range or Content-Length)`);
  }

  async fetchRange(start: number, end: number, reason = '', signal?: AbortSignal): Promise<ArrayBuffer> {
    // Each read owns a controller (so destroy() can abort it); the caller's signal, when given, is
    // linked to it so a seek/scrub supersession cancels the underlying fetch instead of letting it
    // download to completion.
    const ac = new AbortController();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    this.inflight.add(ac);
    const t0 = performance.now();
    try {
      // Transient network errors ("Failed to fetch" TypeError, or a 5xx) get a bounded retry with
      // backoff before failing. Heavy backward stepping at an evicted file region churns HTTP/1.1
      // connections (each step supersedes/aborts the prior read), which intermittently yields a
      // "Failed to fetch" on the next read — and a paused seek that loses its fetch has no timeupdate
      // to retrigger it, so the picture wedges on the last painted frame. A retry self-heals the blip.
      // An abort (genuine supersession) is never retried — it propagates immediately. A 200 (server
      // ignored Range) and a 4xx are not transient either, so they fail without retrying.
      let lastErr: unknown;
      for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
        if (ac.signal.aborted) break; // superseded while backing off — stop and let the throw below fire
        try {
          const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` }, signal: ac.signal });
          // A 200 here means the server ignored the Range and is about to stream the WHOLE file — bail
          // (and cancel the body) rather than download gigabytes for a small read. Not transient.
          if (res.status === 200) {
            try { await res.body?.cancel(); } catch { /* ignore */ }
            throw noRangeError(this.url);
          }
          if (res.status !== 206) {
            const err = new Error(`fetchRange ${start}-${end} failed: ${res.status} ${res.statusText}`);
            if (res.status < 500) throw err;        // 4xx (incl. 416) is not transient — fail now
            lastErr = err; if (attempt < FETCH_RETRIES - 1) await this.backoff(attempt, ac.signal); continue; // 5xx
          }
          const buf = await res.arrayBuffer(); // can also reject on a mid-body network drop
          logRead('HTTP', start, end, reason, performance.now() - t0, this.readStats);
          return buf;
        } catch (e) {
          // Retry only genuine network errors — fetch()/arrayBuffer() reject with a TypeError
          // ("Failed to fetch") on those. Aborts (DOMException), a non-range 200, and 4xx are all
          // plain non-TypeError throws here, so they propagate immediately without a retry.
          if (!(e instanceof TypeError) || ac.signal.aborted) throw e;
          lastErr = e;
          if (attempt < FETCH_RETRIES - 1) await this.backoff(attempt, ac.signal);
        }
      }
      throw new Error(
        `fetchRange ${start}-${end} on ${this.url} failed after ${FETCH_RETRIES} attempts: ` +
        `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    } finally {
      this.inflight.delete(ac);
    }
  }

  /** Sleep `BACKOFF_MS[attempt]` (clamped to the last entry), bailing early if the read is aborted. */
  private backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  destroy(): void {
    for (const ac of this.inflight) ac.abort();
    this.inflight.clear();
  }
}
