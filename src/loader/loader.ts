export interface ILoader {
  readonly fileSize: Promise<number>;
  /**
   * @param reason optional label describing the purpose of the read (for read logging).
   * @param signal optional AbortSignal; aborting it cancels the read (e.g. a seek superseding a
   *        prefetch) so a slow network read isn't downloaded to completion after it's no longer
   *        wanted. Aborted reads reject with an AbortError.
   */
  fetchRange(start: number, end: number, reason?: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  /**
   * Live mode only: re-query the current size of a growing source (a recording still being written),
   * so the live reader can discover bytes appended since {@link fileSize} was first resolved. A
   * lightweight call (HTTP HEAD); ranges are already known to work by the time this is used. Optional
   * because static/finished sources (e.g. a picked File) never grow and don't implement it.
   */
  refreshFileSize?(): Promise<number>;
  destroy(): void;
}

/**
 * Shared read-logging helper. Off by default; set globalThis.MXFJS_LOG_READS = true to enable.
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
  if ((globalThis as { MXFJS_LOG_READS?: boolean }).MXFJS_LOG_READS !== true) return;
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
