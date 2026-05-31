import type { ILoader } from './loader.js';

export class FileLoader implements ILoader {
  private readonly file: File;
  readonly fileSize: Promise<number>;

  constructor(file: File) {
    this.file = file;
    this.fileSize = Promise.resolve(file.size);
  }

  fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const blob = this.file.slice(start, end + 1);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(new Error(`FileReader error reading ${start}-${end}`));
      reader.readAsArrayBuffer(blob);
    });
  }

  destroy(): void {
    // nothing to clean up
  }
}
