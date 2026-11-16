/**
 * MseController.endOfStream() must never shrink the timeline. Per the MSE spec, endOfStream() sets
 * MediaSource.duration to the highest buffered end. Calling it with a partial buffer (the fetch
 * frontier reached EOF after a skip to the end) collapsed the duration, and the browser then clamped
 * every later seek beyond it — the skip-seek-freeze E2E patterns froze with the element parked at the
 * shrunken duration while the player waited for buffer at its real seek target.
 *
 * MediaSource/SourceBuffer don't exist in the Node test environment, so this injects minimal stand-ins
 * into the controller's private state (same approach as mse-controller-reset-queue.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MseController } from '../src/mse/mse-controller.js';

function mockSourceBuffer(ranges: Array<[number, number]>, updating = false) {
  return {
    updating,
    buffered: { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] },
  } as unknown as SourceBuffer;
}

function setup(ranges: Array<[number, number]>, opts: { updating?: boolean; queued?: number } = {}) {
  const controller = new MseController({} as HTMLVideoElement, false);
  const mediaSource = { readyState: 'open', duration: NaN, endOfStream: vi.fn() };
  const c = controller as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  c.mediaSource = mediaSource;
  const sb = mockSourceBuffer(ranges, opts.updating);
  c.sourceBuffers.set('video', sb);
  c.queues.set('video', Array.from({ length: opts.queued ?? 0 }, () => ({ kind: 'append', data: new ArrayBuffer(0) })));
  controller.setDuration(60);
  return { controller, mediaSource, sb, c };
}

afterEach(() => { vi.useRealTimers(); });

describe('MseController.endOfStream', () => {
  it('ends the stream when the buffer reaches the full duration', () => {
    const { controller, mediaSource } = setup([[50, 60]]);
    controller.endOfStream();
    expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
  });

  it('tolerates last-frame rounding just short of the duration', () => {
    const { controller, mediaSource } = setup([[50, 59.96]]);
    controller.endOfStream();
    expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
  });

  it('does NOT end the stream while only part of the file is buffered (would shrink duration)', () => {
    // The skip-seek-freeze case: frontier at EOF, but only 10.00–10.16 s buffered.
    const { controller, mediaSource } = setup([[0, 0.08], [10, 10.16]]);
    controller.endOfStream();
    expect(mediaSource.endOfStream).not.toHaveBeenCalled();
  });

  it('does not end the stream when nothing is buffered', () => {
    const { controller, mediaSource } = setup([]);
    controller.endOfStream();
    expect(mediaSource.endOfStream).not.toHaveBeenCalled();
  });

  it('waits for queued appends before deciding', () => {
    vi.useFakeTimers();
    const { controller, mediaSource, c } = setup([[50, 55]], { queued: 1 });
    controller.endOfStream();
    expect(mediaSource.endOfStream).not.toHaveBeenCalled();
    // The queued final chunk lands: queue drains and the buffer now reaches the end.
    c.queues.set('video', []);
    c.sourceBuffers.set('video', mockSourceBuffer([[50, 60]]));
    vi.advanceTimersByTime(60);
    expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
  });

  it('waits while a SourceBuffer is updating', () => {
    vi.useFakeTimers();
    const { controller, mediaSource, sb } = setup([[50, 60]], { updating: true });
    controller.endOfStream();
    expect(mediaSource.endOfStream).not.toHaveBeenCalled();
    (sb as unknown as { updating: boolean }).updating = false;
    vi.advanceTimersByTime(60);
    expect(mediaSource.endOfStream).toHaveBeenCalledTimes(1);
  });

  it('is a no-op once the MediaSource is no longer open', () => {
    const { controller, mediaSource } = setup([[50, 60]]);
    mediaSource.readyState = 'ended';
    controller.endOfStream();
    expect(mediaSource.endOfStream).not.toHaveBeenCalled();
  });
});
