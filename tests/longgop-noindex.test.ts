import { describe, it, expect } from 'vitest';
import { selectNoIndexLongGopRun, NOINDEX_GOP_LOOKAHEAD } from '../src/worker/longgop-noindex.js';
import { SparseKeyframeIndex } from '../src/essence/sparse-keyframe-index.js';
import type { EssenceFrame } from '../src/essence/essence-extractor.js';
import { buildSliceNal, toAvcc } from './helpers/h264-bitstream.js';

// A closed IBBP GOP of 4 AUs (I P B B) at the given base edit unit; the head is an IDR.
function gopAUs(): Uint8Array[] {
  return [
    toAvcc([buildSliceNal({ sliceType: 2, idr: true, frameNum: 0, picOrderCntLsb: 0 })]),
    toAvcc([buildSliceNal({ sliceType: 0, frameNum: 1, picOrderCntLsb: 6 })]),
    toAvcc([buildSliceNal({ sliceType: 1, frameNum: 2, picOrderCntLsb: 2 })]),
    toAvcc([buildSliceNal({ sliceType: 1, frameNum: 2, picOrderCntLsb: 4 })]),
  ];
}

function vframe(eu: number, avcc: Uint8Array): EssenceFrame {
  return {
    trackType: 'video',
    editUnit: BigInt(eu),
    pts: BigInt(eu),
    dts: BigInt(eu),
    isKeyframe: false,
    data: avcc.buffer.slice(avcc.byteOffset, avcc.byteOffset + avcc.byteLength) as ArrayBuffer,
    byteOffset: BigInt(eu * 1000), // synthetic monotonic byte offset
  };
}

function aframe(eu: number): EssenceFrame {
  return {
    trackType: 'audio',
    editUnit: BigInt(eu),
    pts: BigInt(eu),
    dts: BigInt(eu),
    isKeyframe: false,
    data: new Uint8Array([1, 2, 3, 4]).buffer,
    byteOffset: BigInt(eu * 1000 + 500),
  };
}

/** N consecutive 4-frame GOPs starting at EU 0 (EUs 0..4N-1), video only. */
function videoStream(numGops: number): EssenceFrame[] {
  const frames: EssenceFrame[] = [];
  for (let g = 0; g < numGops; g++) {
    const base = g * 4;
    gopAUs().forEach((au, i) => frames.push(vframe(base + i, au)));
  }
  return frames;
}

async function* iter(frames: EssenceFrame[]): AsyncGenerator<EssenceFrame> {
  for (const f of frames) yield f;
}

const euOf = (f: EssenceFrame) => Number(f.editUnit);

describe('selectNoIndexLongGopRun (Tier-3 no-index GOP alignment)', () => {
  it('forward fetch from a keyframe: keeps one GOP, ends on the next IDR, records keyframes', async () => {
    const kf = new SparseKeyframeIndex();
    const run = (await selectNoIndexLongGopRun(iter(videoStream(3)), {
      startFrame: 0, frameCount: 4, scanBound: 4 + NOINDEX_GOP_LOOKAHEAD, sparseKf: kf,
    }))!;
    expect(run.startStorageEU).toBe(0);
    expect(run.nextFrame).toBe(4);                     // boundary = next IDR
    expect(run.video.map(euOf)).toEqual([0, 1, 2, 3]); // whole GOP, decode order
    // discovered keyframes recorded with their byte offsets
    expect(kf.floor(3n)).toEqual({ editUnit: 0n, byteOffset: 0n });
    expect(kf.floor(7n)).toEqual({ editUnit: 4n, byteOffset: 4000n });
  });

  it('mid-GOP start re-anchors to the enclosing IDR and discards earlier-scanned GOPs', async () => {
    // Cold scan from EU 0 but the request is for EU 6 → must anchor at IDR 4, not 0.
    const run = (await selectNoIndexLongGopRun(iter(videoStream(3)), {
      startFrame: 6, frameCount: 2, scanBound: 8 + NOINDEX_GOP_LOOKAHEAD, sparseKf: new SparseKeyframeIndex(),
    }))!;
    expect(run.startStorageEU).toBe(4);
    expect(run.nextFrame).toBe(8);
    expect(run.video.map(euOf)).toEqual([4, 5, 6, 7]); // GOP0's frames were discarded
  });

  it('trims a trailing partial GOP when the lookahead cap is hit (run ends on a real boundary)', async () => {
    // Two GOPs, no IDR after EU 7; force hit-bound with a small scanBound so the partial GOP1 is
    // dropped back to the GOP0 boundary (so the next fetch starts on keyframe 4, no overlap).
    const run = (await selectNoIndexLongGopRun(iter(videoStream(2)), {
      startFrame: 0, frameCount: 8, scanBound: 8, sparseKf: new SparseKeyframeIndex(),
    }))!;
    expect(run.video.map(euOf)).toEqual([0, 1, 2, 3]);
    expect(run.nextFrame).toBe(4);
    expect(run.startStorageEU).toBe(0);
  });

  it('at EOF keeps the final (possibly partial) GOP and points nextFrame past the end', async () => {
    const frames = [...videoStream(1), vframe(4, gopAUs()[0]), vframe(5, gopAUs()[1])]; // GOP0 + I4 P5
    const run = (await selectNoIndexLongGopRun(iter(frames), {
      startFrame: 0, frameCount: 8, scanBound: 8 + NOINDEX_GOP_LOOKAHEAD, sparseKf: new SparseKeyframeIndex(),
    }))!;
    expect(run.video.map(euOf)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(run.nextFrame).toBe(6); // last EU + 1
  });

  it('retains audio within the run and drops audio scanned before the enclosing keyframe', async () => {
    const frames: EssenceFrame[] = [
      vframe(0, gopAUs()[0]), vframe(1, gopAUs()[1]), aframe(1), vframe(2, gopAUs()[2]), vframe(3, gopAUs()[3]),
      vframe(4, gopAUs()[0]), aframe(4), vframe(5, gopAUs()[1]), vframe(6, gopAUs()[2]), vframe(7, gopAUs()[3]),
      vframe(8, gopAUs()[0]),
    ];
    const run = (await selectNoIndexLongGopRun(iter(frames), {
      startFrame: 6, frameCount: 2, scanBound: 8 + NOINDEX_GOP_LOOKAHEAD, sparseKf: new SparseKeyframeIndex(),
    }))!;
    expect(run.video.map(euOf)).toEqual([4, 5, 6, 7]);
    expect(run.audio.map(euOf)).toEqual([4]); // audio at EU 1 (GOP0) discarded; EU 4 kept
  });

  it('returns null when the scan is aborted (a seek superseded it)', async () => {
    const run = await selectNoIndexLongGopRun(iter(videoStream(3)), {
      startFrame: 0, frameCount: 4, scanBound: 64, sparseKf: new SparseKeyframeIndex(),
      isAborted: () => true,
    });
    expect(run).toBeNull();
  });
});
