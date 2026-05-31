export interface ILoader {
  readonly fileSize: Promise<number>;
  /** @param reason optional label describing the purpose of the read (for read logging). */
  fetchRange(start: number, end: number, reason?: string): Promise<ArrayBuffer>;
  destroy(): void;
}

/**
 * Shared read-logging helper. Off by default; set globalThis.JSMXF_LOG_READS = true to enable.
 * Logs every byte-range read with its purpose, size, latency and a running total so the
 * read pattern (one init burst, then one ~2 s chunk per playback step / seek) is visible.
 */
export function logRead(
  kind: string,
  start: number,
  end: number,
  reason: string,
  ms: number,
  state: { count: number; total: number },
): void {
  if ((globalThis as { JSMXF_LOG_READS?: boolean }).JSMXF_LOG_READS !== true) return;
  state.count++;
  const len = end - start + 1;
  state.total += len;
  const kb = (len / 1024).toFixed(1);
  const totalMb = (state.total / (1024 * 1024)).toFixed(2);
  console.log(
    `[read #${state.count}] ${kind} ${reason || '-'}: bytes ${start}–${end} ` +
    `(${kb} KB) in ${ms.toFixed(1)} ms — cumulative ${totalMb} MB / ${state.count} reads`,
  );
}
