import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BitReader, stripEmulationPrevention } from '../src/essence/bitreader.js';
import {
  parseSpsPocInfo, parsePpsPocInfo, parseSliceHeaderPoc, buildPpsPocMap,
  iterNals, firstSliceNal, isIdrAccessUnit, PocComputer,
} from '../src/essence/h264-poc.js';
import { BitWriter, buildSps, buildPps, buildSliceNal, toAvcc } from './helpers/h264-bitstream.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/xavcl-poc-gop.json', import.meta.url)), 'utf8'),
);

describe('BitReader', () => {
  it('reads u(n) MSB-first', () => {
    const w = new BitWriter();
    w.u(8, 0b10110001);
    w.u(4, 0b1010);
    const r = new BitReader(w.bytes());
    expect(r.u(8)).toBe(0b10110001);
    expect(r.u(4)).toBe(0b1010);
  });

  it('round-trips ue/se exp-golomb', () => {
    const vals = [0, 1, 2, 3, 14, 255, 1023];
    const w = new BitWriter();
    for (const v of vals) w.ue(v);
    for (const v of [0, -1, 1, -7, 8, 42]) w.se(v);
    const r = new BitReader(w.bytes());
    for (const v of vals) expect(r.ue()).toBe(v);
    for (const v of [0, -1, 1, -7, 8, 42]) expect(r.se()).toBe(v);
  });

  it('zero-extends reads past the end', () => {
    const r = new BitReader(new Uint8Array([0xff]));
    expect(r.u(8)).toBe(0xff);
    expect(r.u(4)).toBe(0); // past end → zeros
  });
});

describe('stripEmulationPrevention', () => {
  it('removes 00 00 03 emulation bytes and the header byte', () => {
    // header, then 00 00 03 01 → payload 00 00 01
    const nal = new Uint8Array([0x67, 0x00, 0x00, 0x03, 0x01]);
    expect(Array.from(stripEmulationPrevention(nal))).toEqual([0x00, 0x00, 0x01]);
  });
  it('leaves a 03 that is not preceded by 00 00 intact', () => {
    const nal = new Uint8Array([0x67, 0x01, 0x03, 0x00, 0x03]);
    // skip header; 0x03 after 0x01 stays; final 0x03 after a single 0x00 stays
    expect(Array.from(stripEmulationPrevention(nal))).toEqual([0x01, 0x03, 0x00, 0x03]);
  });
});

describe('parseSpsPocInfo', () => {
  it('recovers the proven xavc_l fields from a matching synthetic SPS', () => {
    const sps = buildSps({
      profileIdc: fixture.sps.profileIdc,
      log2MaxFrameNum: fixture.sps.log2MaxFrameNum,
      picOrderCntType: fixture.sps.picOrderCntType,
      log2MaxPicOrderCntLsb: fixture.sps.log2MaxPicOrderCntLsb,
      frameMbsOnly: fixture.sps.frameMbsOnlyFlag,
    });
    const info = parseSpsPocInfo(sps)!;
    expect(info).not.toBeNull();
    expect(info.profileIdc).toBe(100);
    expect(info.picOrderCntType).toBe(0);
    expect(info.log2MaxPicOrderCntLsb).toBe(6);
    expect(info.log2MaxFrameNum).toBe(4);
    expect(info.frameMbsOnlyFlag).toBe(true);
    expect(info.separateColourPlaneFlag).toBe(false);
  });
});

describe('parsePpsPocInfo', () => {
  it('reads the bottom-field POC flag', () => {
    expect(parsePpsPocInfo(buildPps(false))!.bottomFieldPicOrderInFramePresentFlag).toBe(false);
    expect(parsePpsPocInfo(buildPps(true))!.bottomFieldPicOrderInFramePresentFlag).toBe(true);
    expect(parsePpsPocInfo(buildPps(false))!.ppsId).toBe(0);
  });
});

describe('NAL iteration', () => {
  it('walks NALUs and reads type / ref_idc', () => {
    const sps = buildSps();
    const pps = buildPps();
    const idr = buildSliceNal({ sliceType: 2, idr: true, frameNum: 0, picOrderCntLsb: 0 });
    const avcc = toAvcc([sps, pps, idr]);
    const nals = [...iterNals(avcc)];
    expect(nals.map(n => n.type)).toEqual([7, 8, 5]);
    expect(nals[2].refIdc).toBe(3);
    expect(firstSliceNal(avcc)!.type).toBe(5);
    expect(isIdrAccessUnit(avcc)).toBe(true);
  });
});

describe('parseSliceHeaderPoc', () => {
  const sps = parseSpsPocInfo(buildSps())!;
  const ppsMap = buildPpsPocMap([buildPps(false)]);

  it('parses slice_type, frame_num and pic_order_cnt_lsb', () => {
    const nal = firstSliceNal(toAvcc([buildSliceNal({ sliceType: 1, frameNum: 3, picOrderCntLsb: 4 })]))!;
    const sh = parseSliceHeaderPoc(nal, sps, ppsMap)!;
    expect(sh.sliceType).toBe(1); // B
    expect(sh.frameNum).toBe(3);
    expect(sh.picOrderCntLsb).toBe(4);
    expect(sh.fieldPicFlag).toBe(false);
    expect(sh.nalRefIdc).toBe(0); // B default
  });

  it('reads idr_pic_id for IDR slices and marks isIdr', () => {
    const nal = firstSliceNal(toAvcc([buildSliceNal({ sliceType: 2, idr: true, frameNum: 0, picOrderCntLsb: 0 })]))!;
    const sh = parseSliceHeaderPoc(nal, sps, ppsMap)!;
    expect(sh.isIdr).toBe(true);
    expect(sh.picOrderCntLsb).toBe(0);
  });
});

describe('PocComputer (type 0)', () => {
  const sps = parseSpsPocInfo(buildSps())!;
  const ppsMap = buildPpsPocMap([buildPps(false)]);

  function pocFor(specs: { sliceType: number; idr?: boolean; refIdc?: number; frameNum: number; lsb: number }[]) {
    const poc = new PocComputer();
    poc.reset();
    return specs.map(s => {
      const nal = firstSliceNal(toAvcc([buildSliceNal({
        sliceType: s.sliceType, idr: s.idr, refIdc: s.refIdc, frameNum: s.frameNum, picOrderCntLsb: s.lsb,
      })]))!;
      const sh = parseSliceHeaderPoc(nal, sps, ppsMap)!;
      return poc.computeFrame(sh, sps);
    });
  }

  it('returns pic_order_cnt_lsb as POC within one IDR period (no wrap)', () => {
    // decode I(0) P(6) B(2) B(4) — the proven IBBP lsb sequence
    const pocs = pocFor([
      { sliceType: 2, idr: true, frameNum: 0, lsb: 0 },
      { sliceType: 0, frameNum: 1, lsb: 6 },
      { sliceType: 1, frameNum: 2, lsb: 2 },
      { sliceType: 1, frameNum: 2, lsb: 4 },
    ]);
    expect(pocs).toEqual([0, 6, 2, 4]);
  });

  it('handles pic_order_cnt_lsb wrap-around using the MSB rule', () => {
    // log2MaxLsb=6 → MaxLsb=64. Climb 0→30→60 (reference pics), then lsb wraps to 2 → MSB += 64.
    const pocs = pocFor([
      { sliceType: 2, idr: true, frameNum: 0, lsb: 0 },
      { sliceType: 0, refIdc: 2, frameNum: 1, lsb: 30 },
      { sliceType: 0, refIdc: 2, frameNum: 2, lsb: 60 },
      { sliceType: 0, refIdc: 2, frameNum: 3, lsb: 2 }, // wrapped past 64 → poc 66
    ]);
    expect(pocs).toEqual([0, 30, 60, 66]);
  });

  it('does not let a non-reference picture advance the prediction state', () => {
    // A non-ref B at a high lsb between two refs must not shift the MSB baseline for the next ref.
    const pocs = pocFor([
      { sliceType: 2, idr: true, frameNum: 0, lsb: 0 },
      { sliceType: 0, refIdc: 2, frameNum: 1, lsb: 4 },   // ref, poc 4
      { sliceType: 1, refIdc: 0, frameNum: 1, lsb: 2 },   // non-ref B, poc 2 — state unchanged
      { sliceType: 0, refIdc: 2, frameNum: 2, lsb: 8 },   // ref, poc 8 (relative to lsb=4, not 2)
    ]);
    expect(pocs).toEqual([0, 4, 2, 8]);
  });
});
