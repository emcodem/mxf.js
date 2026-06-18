import { ILoader, LoaderStats, logRead } from './loader.js';

export class FileLoader implements ILoader {
  private readonly file: File;
  readonly fileSize: Promise<number>;
  private readStats = { count: 0, total: 0 };
  // Cumulative bytes read from the File (no network here, so requestsInFlight is always 0).
  private bytesTotal = 0;
  private requestsTotal = 0;

  constructor(file: File) {
    this.file = file;
    this.fileSize = Promise.resolve(file.size);
  }

  /** Traffic counters. A picked File is read locally (no network), so in-flight stays 0; bytesTotal
   *  still reflects how much of the file the pipeline has pulled. */
  getStats(): LoaderStats {
    return { bytesTotal: this.bytesTotal, requestsInFlight: 0, requestsTotal: this.requestsTotal };
  }

  fetchRange(start: number, end: number, reason = '', signal?: AbortSignal): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const t0 = performance.now();
      const blob = this.file.slice(start, end + 1);
      const reader = new FileReader();
      const onAbort = () => { reader.abort(); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      reader.onload = () => {
        signal?.removeEventListener('abort', onAbort);
        const buf = reader.result as ArrayBuffer;
        this.bytesTotal += buf.byteLength;
        this.requestsTotal++;
        logRead('File', start, end, reason, performance.now() - t0, this.readStats);
        resolve(buf);
      };
      reader.onerror = () => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return; // already rejected via onAbort
        reject(new Error(`FileReader error reading ${start}-${end}`));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  destroy(): void {
    // nothing to clean up
  }
}

/** A DOMException-style AbortError, matching what fetch() throws so callers can detect cancellation. */
function abortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}
