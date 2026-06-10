/**
 * Regression: scrub/skip to the END of a clip must land on the LAST displayable frame, not one past it.
 *
 * `duration` is the END time of the last frame, so clamping a seek target to `duration` resolves to
 * frame index `totalFrames` — one PAST the last valid frame (`totalFrames - 1`). The worker can't
 * decode a frame there, so the picture never updates and the <video> clamps the playhead back to the
 * buffered end ("hit ↑ to jump to the end → no picture change, thumb stuck mid-bar"). The ScrubController
 * (which drives ↑/↓ skip and slider release) must clamp preview + settle targets to the last frame.
 *
 * Run: npx vitest run tests/scrub-end-clamp.test.ts
 */
import { describe, it, expect } from 'vitest';
import { ScrubController } from '../src/scrub-controller.js';

/** Minimal stand-in for the bits of HTMLVideoElement the ScrubController touches. */
function fakeVideo() {
  return { currentTime: 0, paused: true, pause() { this.paused = true; } } as unknown as HTMLVideoElement;
}

describe('scrub/skip end-of-clip clamp', () => {
  // 10.0 s @ 25 fps = 250 frames, valid indices 0..249. The last frame starts at 249/25 = 9.96 s.
  const DURATION = 10.0, FPS_NUM = 25, FPS_DEN = 1;
  const LAST_FRAME = 249;
  const LAST_FRAME_TIME = LAST_FRAME / (FPS_NUM / FPS_DEN); // 9.96

  it('previews the LAST frame (not totalFrames) when scrubbing to/past the end', () => {
    const previews: number[] = [];
    const video = fakeVideo();
    const scrub = new ScrubController(
      video,
      (targetFrame) => previews.push(targetFrame),
      () => {},
      () => {},
    );
    scrub.setStream(DURATION, FPS_NUM, FPS_DEN);
    scrub.beginScrub();
    scrub.scrubTo(DURATION);       // drag to the very end (or past it)
    scrub.scrubTo(DURATION + 5);   // overshoot must clamp identically

    expect(previews.length).toBeGreaterThan(0);
    // Frame 250 (= duration*fps) is one past EOF and decodes to nothing — must be clamped to 249.
    expect(Math.max(...previews)).toBe(LAST_FRAME);
  });

  it('settles on the last frame time, not duration', () => {
    let settled = -1;
    const video = fakeVideo();
    const scrub = new ScrubController(
      video,
      () => {},
      (t) => { settled = t; },
      () => {},
    );
    scrub.setStream(DURATION, FPS_NUM, FPS_DEN);
    scrub.beginScrub();
    scrub.endScrub(DURATION);   // release at the end

    expect(settled).toBeCloseTo(LAST_FRAME_TIME, 6);
    expect(video.currentTime).toBeCloseTo(LAST_FRAME_TIME, 6);
    // Crucially NOT duration — that lands past the last frame and paints nothing.
    expect(settled).toBeLessThan(DURATION);
  });
});
