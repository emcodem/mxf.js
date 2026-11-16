/**
 * MseController.resetQueue() (src/mse/mse-controller.ts): regression coverage for
 * todo_transcode_stall_and_fallback.md Issue A's "SourceBuffer.abort() never called" finding.
 *
 * MseController isn't designed for unit isolation (it's MSE/HTMLVideoElement glue, exercised via
 * the E2E suite in practice) — this test reaches into its private state directly to isolate
 * resetQueue() itself, since MediaSource/SourceBuffer aren't available in the Node test
 * environment (vitest.config.ts runs environment: 'node', no jsdom/browser media APIs).
 */
import { describe, it, expect, vi } from 'vitest';
import { MseController } from '../src/mse/mse-controller.js';

// Minimal SourceBuffer stand-in: only what resetQueue() touches.
function mockSourceBuffer(updating: boolean) {
  return { updating, abort: vi.fn(), buffered: { length: 0 } } as unknown as SourceBuffer;
}

function newController(): MseController {
  // The constructor only stores the video element; resetQueue() never touches it.
  return new MseController({} as HTMLVideoElement, false);
}

describe('MseController.resetQueue', () => {
  it('aborts a real SourceBuffer that is still updating', () => {
    const controller = newController();
    const sb = mockSourceBuffer(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).sourceBuffers.set('video', sb);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).queues.set('video', [{ kind: 'append', data: new ArrayBuffer(0) }]);

    controller.resetQueue('video');

    expect(sb.abort).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((controller as any).queues.get('video')).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((controller as any).processing.get('video')).toBe(false);
  });

  it('does not call abort() when the SourceBuffer is not updating', () => {
    const controller = newController();
    const sb = mockSourceBuffer(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).sourceBuffers.set('video', sb);

    controller.resetQueue('video');

    expect(sb.abort).not.toHaveBeenCalled();
  });

  it('swallows an exception from abort() (e.g. readyState already moved on)', () => {
    const controller = newController();
    const sb = mockSourceBuffer(true);
    (sb.abort as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new DOMException('closed', 'InvalidStateError');
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).sourceBuffers.set('video', sb);

    expect(() => controller.resetQueue('video')).not.toThrow();
  });

  it('is a no-op when no SourceBuffer exists for the track (codec not supported)', () => {
    const controller = newController();
    expect(() => controller.resetQueue('audio')).not.toThrow();
  });
});
