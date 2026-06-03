import { ILoader, logRead } from './loader.js';

export class FileLoader implements ILoader {
  private readonly file: File;
  readonly fileSize: Promise<number>;
  private readStats = { count: 0, total: 0 };

  constructor(file: File) {
    this.file = file;
    this.fileSize = Promise.resolve(file.size);
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
        logRead('File', start, end, reason, performance.now() - t0, this.readStats);
        resolve(reader.result as ArrayBuffer);
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
