import { ILoader, logRead } from './loader.js';

export class FileLoader implements ILoader {
  private readonly file: File;
  readonly fileSize: Promise<number>;
  private readStats = { count: 0, total: 0 };

  constructor(file: File) {
    this.file = file;
    this.fileSize = Promise.resolve(file.size);
  }

  fetchRange(start: number, end: number, reason = ''): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const blob = this.file.slice(start, end + 1);
      const reader = new FileReader();
      reader.onload = () => {
        logRead('File', start, end, reason, performance.now() - t0, this.readStats);
        resolve(reader.result as ArrayBuffer);
      };
      reader.onerror = () => reject(new Error(`FileReader error reading ${start}-${end}`));
      reader.readAsArrayBuffer(blob);
    });
  }

  destroy(): void {
    // nothing to clean up
  }
}
