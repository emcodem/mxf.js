/**
 * computeSeekChunkFrames() (src/mxf-player.ts): the post-seek fetch-size floor. See its doc comment
 * for the full rationale — regression coverage for todo_transcode_stall_and_fallback.md Issue A
 * (a tiny post-seek chunk on a transcode path reliably wedged the browser's H.264 decoder).
 */
import { describe, it, expect } from 'vitest';
import { computeSeekChunkFrames } from '../src/mxf-player.js';

describe('computeSeekChunkFrames', () => {
  it('uses the small keyframe-to-target formula for a native remux seek with a real index', () => {
    // seekTargetFrame - keyframe + 3 = 87 - 80 + 3 = 10, well under framesPerChunk.
    expect(computeSeekChunkFrames('vbe', false, 50, 87, 80)).toBe(10);
  });

  it('floors to at least 1 frame even when the seek lands exactly on its own keyframe', () => {
    // seekTargetFrame === keyframe (a seek-in-place recovery re-targeting the same stuck position
    // on an all-intra source) collapses the formula to exactly 3 for a native (non-transcode) path.
    expect(computeSeekChunkFrames('vbe', false, 50, 80, 80)).toBe(3);
  });

  it('caps the small formula at framesPerChunk', () => {
    // seekTargetFrame - keyframe + 3 = 500, but framesPerChunk = 50 should win.
    expect(computeSeekChunkFrames('cbg', false, 50, 583, 80)).toBe(50);
  });

  it('floors to framesPerChunk for a transcode path even when the small formula would be tiny', () => {
    // Same same-position seek-in-place case as above, but isTranscode=true (MPEG-2/ProRes
    // re-encoded to H.264) — this is the exact scenario that reliably wedged the hardware decoder.
    expect(computeSeekChunkFrames('vbe', true, 50, 80, 80)).toBe(50);
  });

  it("floors to framesPerChunk when indexMode is 'none', regardless of isTranscode", () => {
    expect(computeSeekChunkFrames('none', false, 50, 87, 80)).toBe(50);
    expect(computeSeekChunkFrames('none', true, 50, 87, 80)).toBe(50);
  });

  it('floors to framesPerChunk when indexMode is null (no manifest index info yet)', () => {
    expect(computeSeekChunkFrames(null, false, 50, 87, 80)).toBe(50);
  });
});
