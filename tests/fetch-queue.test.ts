import { describe, it, expect } from 'vitest';
import { FetchQueue } from '../src/worker/fetch-queue.js';

describe('FetchQueue', () => {
  it('bumps generation and clears pending jobs on supersede', () => {
    const q = new FetchQueue(async () => { await new Promise(() => {}); /* never resolves */ });
    const g0 = q.currentGeneration;
    q.enqueue({ startFrame: 0, frameCount: 1, seqBase: 0 });
    q.enqueue({ startFrame: 1, frameCount: 1, seqBase: 0 });
    expect(q.supersede()).toBe(g0 + 1);
  });

  it('aborts the in-flight job signal on supersede', async () => {
    let captured: AbortSignal | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = new FetchQueue(async (_job, signal) => { captured = signal; await gate; });

    q.enqueue({ startFrame: 0, frameCount: 1, seqBase: 0 });
    await Promise.resolve();
    await Promise.resolve(); // let drain() start the job

    expect(captured).not.toBeNull();
    expect(captured!.aborted).toBe(false);
    q.supersede();
    expect(captured!.aborted).toBe(true);
    release(); // let the job finish so the queue drains cleanly
  });

  it('runs jobs one at a time in order', async () => {
    const order: number[] = [];
    let active = 0, maxActive = 0;
    const q = new FetchQueue(async (job) => {
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      order.push(job.startFrame);
      active--;
    });
    q.enqueue({ startFrame: 1, frameCount: 1, seqBase: 0 });
    q.enqueue({ startFrame: 2, frameCount: 1, seqBase: 0 });
    q.enqueue({ startFrame: 3, frameCount: 1, seqBase: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1); // never concurrent
  });
});
