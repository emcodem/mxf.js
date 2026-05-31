export interface ILoader {
  readonly fileSize: Promise<number>;
  fetchRange(start: number, end: number): Promise<ArrayBuffer>;
  destroy(): void;
}
