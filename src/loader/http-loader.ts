import type { ILoader } from './loader.js';

export class HttpLoader implements ILoader {
  private readonly url: string;
  readonly fileSize: Promise<number>;
  private abortController: AbortController | null = null;

  constructor(url: string) {
    this.url = url;
    this.fileSize = this.fetchFileSize();
  }

  private async fetchFileSize(): Promise<number> {
    const res = await fetch(this.url, { method: 'HEAD' });
    if (!res.ok) throw new Error(`HEAD ${this.url} failed: ${res.status}`);
    const len = res.headers.get('content-length');
    if (!len) throw new Error('Server did not return Content-Length');
    return parseInt(len, 10);
  }

  async fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    this.abortController = new AbortController();
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: this.abortController.signal,
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`fetchRange ${start}-${end} failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }

  destroy(): void {
    this.abortController?.abort();
  }
}
