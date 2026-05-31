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
}

export class FetchQueue {
  private busy = false;
  private readonly queue: FetchJob[] = [];
  private generation = 0;

  /** @param run Executes one job. The queue awaits it to completion before starting the next. */
  constructor(private readonly run: (job: FetchJob) => Promise<void>) {}

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
    return this.generation;
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        await this.run(this.queue.shift()!);
      }
    } finally {
      this.busy = false;
    }
  }
}
