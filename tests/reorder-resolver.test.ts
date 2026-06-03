import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeReorder, resolveReorder, accessUnitHasBSlice } from '../src/essence/reorder-resolver.js';
import type { ReorderItem, ReorderInputFrame } from '../src/essence/reorder-resolver.js';
import { parseSpsPocInfo, buildPpsPocMap } from '../src/essence/h264-poc.js';
import { buildSps, buildPps, buildSliceNal, toAvcc } from './helpers/h264-bitstream.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/xavcl-poc-gop.json', import.meta.url)), 'utf8'),
);

const sps = parseSpsPocInfo(buildSps())!;
const ppsFlagMap = buildPpsPocMap([buildPps(false)]);

function item(poc: number, opts: Partial<ReorderItem> = {}): ReorderItem {
  return { poc, isGopHead: false, isSync: false, fieldPic: false, sourceIndex: 0, ...opts };
}

describe('computeReorder (pure ranking core)', () => {
  it('reorders one closed IBBP GOP: contiguous DTS, ranked PTS, IBBP CTS pattern', () => {
    // decode I P B B with POC 0 6 2 4 → display I B B P
    const items: ReorderItem[] = [
      item(0, { isGopHead: true, isSync: true, sourceIndex: 0 }),
      item(6, { sourceIndex: 1 }),
      item(2, { sourceIndex: 2 }),
      item(4, { sourceIndex: 3 }),
    ];
    const out = computeReorder(items, 100n, false)!;
    expect(out.map(s => Number(s.dts - 100n))).toEqual([0, 1, 2, 3]); // contiguous decode order
    expect(out.map(s => Number(s.pts - 100n))).toEqual([0, 3, 1, 2]); // display rank
    expect(out.map(s => Number(s.pts - s.dts))).toEqual(fixture.miniGop.ctsInDecodeOrder); // [0,2,-1,-1]
    expect(out[0].isKeyframe).toBe(true);
  });

  it('PTS is gapless across the run (a permutation of startEU..startEU+N-1)', () => {
    const items: ReorderItem[] = [
      item(0, { isGopHead: true, isSync: true, sourceIndex: 0 }),
      item(6, { sourceIndex: 1 }), item(2, { sourceIndex: 2 }), item(4, { sourceIndex: 3 }),
    ];
    const out = computeReorder(items, 0n, false)!;
    expect(out.map(s => Number(s.pts)).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('ranks each GOP independently and tiles two GOPs (DTS stays contiguous across the boundary)', () => {
    const gop = (base: number): ReorderItem[] => [
      item(0, { isGopHead: true, isSync: true, sourceIndex: base + 0 }),
      item(6, { sourceIndex: base + 1 }), item(2, { sourceIndex: base + 2 }), item(4, { sourceIndex: base + 3 }),
    ];
    const out = computeReorder([...gop(0), ...gop(4)], 100n, false)!;
    expect(out.map(s => Number(s.dts - 100n))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(out.map(s => Number(s.pts - 100n))).toEqual([0, 3, 1, 2, 4, 7, 5, 6]);
    // No PTS/DTS overlap between the two GOPs — they tile.
    expect(Math.max(...out.slice(0, 4).map(s => Number(s.pts)))).toBeLessThan(
      Math.min(...out.slice(4).map(s => Number(s.pts))),
    );
  });

  it('drops open-GOP leading B-frames at a seek boundary (POC < head), then renumbers contiguously', () => {
    // Open GOP: two leading B's (POC 2,4) decoded after the I but referencing the previous GOP,
    // i.e. displaying before the I (head POC 8). At a boundary they must be dropped.
    const items: ReorderItem[] = [
      item(8, { isGopHead: true, isSync: true, sourceIndex: 0 }), // I (head)
      item(2, { sourceIndex: 1 }),   // leading B — drop
      item(4, { sourceIndex: 2 }),   // leading B — drop
      item(14, { sourceIndex: 3 }),  // P
      item(10, { sourceIndex: 4 }),  // B
      item(12, { sourceIndex: 5 }),  // B
    ];
    const out = computeReorder(items, 100n, true)!;
    expect(out.map(s => s.sourceIndex)).toEqual([0, 3, 4, 5]); // leading B's gone
    expect(out.map(s => Number(s.dts - 100n))).toEqual([0, 1, 2, 3]); // contiguous from the head
    expect(out.map(s => Number(s.pts - 100n))).toEqual([0, 3, 1, 2]); // I first, then B B P
    expect(out[0].isKeyframe).toBe(true);
  });

  it('does NOT drop leading B-frames when not at a boundary (mid-stream contiguous run)', () => {
    const items: ReorderItem[] = [
      item(8, { isGopHead: true, isSync: true, sourceIndex: 0 }),
      item(2, { sourceIndex: 1 }), item(4, { sourceIndex: 2 }),
    ];
    const out = computeReorder(items, 0n, false)!;
    expect(out.length).toBe(3);
  });

  it('returns null (→ fallback) when a field picture is present', () => {
    expect(computeReorder([item(0, { fieldPic: true })], 0n, false)).toBeNull();
  });
});

describe('resolveReorder (end-to-end with synthetic AVCC)', () => {
  function gopFrames(startEU: number): ReorderInputFrame[] {
    const specs = [
      { sliceType: 2, idr: true, frameNum: 0, lsb: 0 },  // I (POC 0)
      { sliceType: 0, frameNum: 1, lsb: 6 },             // P (POC 6)
      { sliceType: 1, frameNum: 2, lsb: 2 },             // B (POC 2)
      { sliceType: 1, frameNum: 2, lsb: 4 },             // B (POC 4)
    ];
    return specs.map((s, i) => ({
      avcc: toAvcc([buildSliceNal({ sliceType: s.sliceType, idr: s.idr, frameNum: s.frameNum, picOrderCntLsb: s.lsb })]),
      editUnit: BigInt(startEU + i),
      meta: null,
    }));
  }

  it('parses POC from the bitstream and produces the proven IBBP ordering', () => {
    const out = resolveReorder(gopFrames(100), {
      sps, ppsFlagMap, startStorageEU: 100n, isRunKeyframeBoundary: true,
    });
    expect(out.map(s => Number(s.dts - 100n))).toEqual([0, 1, 2, 3]);
    expect(out.map(s => Number(s.pts - 100n))).toEqual([0, 3, 1, 2]);
    expect(out.map(s => Number(s.pts - s.dts))).toEqual(fixture.ctsByType
      ? [fixture.ctsByType.I, fixture.ctsByType.P, fixture.ctsByType.B, fixture.ctsByType.B]
      : [0, 2, -1, -1]);
    expect(out[0].isKeyframe).toBe(true); // IDR is the only sync sample
    expect(out.slice(1).every(s => !s.isKeyframe)).toBe(true);
  });

  it('Tier 1: uses index temporalOffset directly when present (no reliance on POC ranking)', () => {
    const frames = gopFrames(0).map((f, i) => ({
      ...f,
      meta: { temporalOffset: [0, 2, -1, -1][i], flags: 0, isKeyframe: i === 0 },
    }));
    const out = resolveReorder(frames, { sps, ppsFlagMap, startStorageEU: 0n, isRunKeyframeBoundary: true });
    expect(out.map(s => Number(s.dts))).toEqual([0, 1, 2, 3]);
    expect(out.map(s => Number(s.pts))).toEqual([0, 3, 1, 2]);
    expect(out[0].isKeyframe).toBe(true);
  });

  it('Tier 1: drops open-GOP leading B-frames at a boundary using temporalOffset', () => {
    // Storage/decode order with index temporalOffsets. Display EU = storageIndex + temporalOffset.
    // The head (I, sourceIndex 0) displays at 2; the two leading B's display before it (0 and 1) and
    // must be dropped on a boundary run. Tier 1 doesn't parse the bitstream, so avcc is a stub.
    const stub = new Uint8Array([0, 0, 0, 2, 0x09, 0x00]);
    const tos = [2, -2, -1, 2, -1, -1]; // displayEu = i + to → [2, -1, 1, 5, 3, 4]
    const frames: ReorderInputFrame[] = tos.map((to, i) => ({
      avcc: stub,
      editUnit: BigInt(i),
      meta: { temporalOffset: to, flags: 0, isKeyframe: i === 0 },
    }));
    const out = resolveReorder(frames, { sps, ppsFlagMap, startStorageEU: 0n, isRunKeyframeBoundary: true });
    expect(out.map(s => s.sourceIndex)).toEqual([0, 3, 4, 5]);     // leading B's (1,2) dropped
    expect(out.map(s => Number(s.dts))).toEqual([0, 1, 2, 3]);     // contiguous decode from the head
    expect(out.map(s => Number(s.pts))).toEqual([2, 5, 3, 4]);     // preserved display positions
    expect(out[0].isKeyframe).toBe(true);

    // Same frames, NOT a boundary → nothing dropped (mid-stream contiguous run).
    const out2 = resolveReorder(frames, { sps, ppsFlagMap, startStorageEU: 0n, isRunKeyframeBoundary: false });
    expect(out2.length).toBe(6);
  });

  it('falls back to decode order (zero CTS) when slices cannot be parsed', () => {
    const garbage: ReorderInputFrame[] = [
      { avcc: new Uint8Array([0, 0, 0, 2, 0x09, 0x00]), editUnit: 5n, meta: { temporalOffset: 0, flags: 0, isKeyframe: true } },
      { avcc: new Uint8Array([0, 0, 0, 2, 0x09, 0x00]), editUnit: 6n, meta: { temporalOffset: 0, flags: 0, isKeyframe: false } },
    ];
    const out = resolveReorder(garbage, { sps, ppsFlagMap, startStorageEU: 5n, isRunKeyframeBoundary: false });
    expect(out.map(s => Number(s.pts))).toEqual([5, 6]);
    expect(out.map(s => Number(s.dts))).toEqual([5, 6]);
    expect(out.map(s => Number(s.pts - s.dts))).toEqual([0, 0]); // zero CTS
  });
});

describe('accessUnitHasBSlice (Long-GOP detection)', () => {
  it('detects a B slice, and reports none for an I-only access unit', () => {
    const bAu = toAvcc([buildSliceNal({ sliceType: 1, frameNum: 1, picOrderCntLsb: 2 })]);
    const iAu = toAvcc([buildSps(), buildPps(), buildSliceNal({ sliceType: 2, idr: true, frameNum: 0, picOrderCntLsb: 0 })]);
    expect(accessUnitHasBSlice(bAu, sps, ppsFlagMap)).toBe(true);
    expect(accessUnitHasBSlice(iAu, sps, ppsFlagMap)).toBe(false);
  });
});
