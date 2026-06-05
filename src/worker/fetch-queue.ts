/**
 * Single-flight fetch serializer with seek-supersession, extracted from the demux worker.
 *
 * fetchSegment must never run concurrently with itself: the decoder and encoder are shared
 * persistent objects, and if two fetches interleave, at the `await encoder.flush()` point one
 * yields and the other's decode loop runs into the SAME encoder queue — so a single flush() drains
 * everyone's frames (the "50 in → 200 out" symptom). This queue runs exactly one job at a time and
 * lets a seek discard superseded work.
 *
 * Each job carries the generation it was enqueued at. A seek/scrub calls supersede(), which bumps
 * the live generation and drops pending jobs; an in-flight job compares its captured `gen` against
 * `currentGeneration` after each await and abandons stale work instead of appending it.
 */
export interface FetchJob {
  startFrame: number;
  frameCount: number;
  seqBase: number;
  stretchToFrames: number;
  gen: number;
  /** Set for throwaway scrub-preview decodes; carries the seq the player matches its reply to. */
  previewSeq?: number;
  /** If set, reset the MPEG-2 pipeline to this frame before decoding (used by speculative cache-fill
   *  jobs, which run after the primary preview and need to reposition the shared decoder). */
  resetToFrame?: number;
  /** If true, this is a background speculative cache-fill: decode + cache but post nothing to the
   *  player (no videoSegment, no previewDone, no segmentDone). Superseded cleanly by any real drag. */
  cacheOnly?: boolean;
}

export class FetchQueue {
  private busy = false;
  private readonly queue: FetchJob[] = [];
  private generation = 0;
  /** Abort controller for the job currently running, so supersede() can cancel its in-flight read. */
  private currentAbort: AbortController | null = null;

  /**
   * @param run Executes one job, receiving an AbortSignal that fires when the job is superseded.
   *   The queue awaits it to completion before starting the next.
   * @param onSupersede Optional hook fired inside supersede(), so a worker that keeps read-ahead
   *   state outside the queue (e.g. a speculative byte prefetch) can abort it in the same choke point
   *   that drops queued/in-flight jobs.
   */
  constructor(
    private readonly run: (job: FetchJob, signal: AbortSignal) => Promise<void>,
    private readonly onSupersede?: () => void,
  ) {}

  /** The live generation. An in-flight job whose captured gen differs has been superseded. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Enqueue a job (defaulting its generation to the current one) and ensure the drain loop runs. */
  enqueue(job: Omit<FetchJob, 'gen' | 'stretchToFrames'> & { gen?: number; stretchToFrames?: number }): void {
    this.queue.push({
      ...job,
      stretchToFrames: job.stretchToFrames ?? 0,
      gen: job.gen ?? this.generation,
    });
    void this.drain();
  }

  /**
   * Supersede any queued/in-flight work from an old position: bump the generation and drop pending
   * jobs. An in-flight job checks currentGeneration after its awaits and discards its (now stale)
   * frames rather than appending them. Returns the new generation.
   */
  supersede(): number {
    this.generation++;
    this.queue.length = 0;
    this.currentAbort?.abort(); // cancel the in-flight read so it doesn't download to completion
    this.onSupersede?.();       // let the worker abort any speculative read-ahead it owns
    return this.generation;
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.currentAbort = new AbortController();
        try {
          await this.run(job, this.currentAbort.signal);
        } finally {
          this.currentAbort = null;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
