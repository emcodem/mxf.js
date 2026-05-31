import { ILoader, logRead } from './loader.js';

/**
 * Error message shown when the server returns 200 instead of 206 for a Range request — i.e. it
 * ignored the Range header and would send the WHOLE file for every read. Streaming MXF requires
 * real byte-range support.
 */
function noRangeError(url: string): Error {
  return new Error(
    `${url}: the server ignored the Range request (responded 200, not 206 Partial Content). ` +
    `It does not support byte-range requests, which jsmxf needs to stream without downloading the ` +
    `entire file. Use a range-capable static server — e.g. \`npx http-server --cors\`, nginx, or ` +
    `caddy. Python's \`http.server\` does NOT support ranges.`,
  );
}

export class HttpLoader implements ILoader {
  private readonly url: string;
  readonly fileSize: Promise<number>;
  private abortController: AbortController | null = null;
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

  async fetchRange(start: number, end: number, reason = ''): Promise<ArrayBuffer> {
    this.abortController = new AbortController();
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: this.abortController.signal,
      });
    } catch (e) {
      throw new Error(
        `fetchRange ${start}-${end} on ${this.url} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // A 200 here means the server ignored the Range and is about to stream the WHOLE file — bail
    // (and cancel the body) rather than download gigabytes for a small read.
    if (res.status === 200) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw noRangeError(this.url);
    }
    if (res.status !== 206) {
      throw new Error(`fetchRange ${start}-${end} failed: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    logRead('HTTP', start, end, reason, performance.now() - t0, this.readStats);
    return buf;
  }

  destroy(): void {
    this.abortController?.abort();
  }
}
