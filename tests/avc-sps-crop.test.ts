/**
 * Tests addSpsFrameCropping: inject frame_cropping into an SPS so the coded (MB-aligned) frame is
 * cropped to the active display size. Chrome's WebCodecs VideoEncoder omits frame_cropping even when
 * displayHeight < codedHeight (1080 vs 1088), so the player would otherwise render the padded bottom
 * rows (a smeared bottom macroblock row). Verifies the resulting SPS re-parses to the right display
 * dims with the POC fields and the trailing VUI bits preserved.
 */
import { describe, it, expect } from 'vitest';
import { addSpsFrameCropping } from '../src/essence/avc-tools.js';
import { parseSpsPocInfo } from '../src/essence/h264-poc.js';
import { BitReader, stripEmulationPrevention } from '../src/essence/bitreader.js';
import { BitWriter } from './helpers/h264-bitstream.js';

/**
 * A complete Main-profile SPS (1920 × 16·(picHeightInMapUnitsMinus1+1)), including the post-
 * frame_mbs_only fields and rbsp_trailing_bits — what Chrome's encoder emits. `tail` is written
 * verbatim after vui_parameters_present_flag (defaults to none) to test tail preservation.
 */
function buildFullSps(opts: {
  frameMbsOnly?: boolean; picHeightInMapUnitsMinus1?: number; profileIdc?: number;
  vuiPresent?: boolean; tail?: number[];
} = {}): Uint8Array {
  const { frameMbsOnly = true, picHeightInMapUnitsMinus1 = 67, profileIdc = 77,
          vuiPresent = false, tail = [] } = opts;
  const w = new BitWriter();
  w.u(8, profileIdc); w.u(8, 0); w.u(8, 40);
  w.ue(0);                          // seq_parameter_set_id
  w.ue(0);                          // log2_max_frame_num_minus4
  w.ue(0);                          // pic_order_cnt_type = 0
  w.ue(2);                          // log2_max_pic_order_cnt_lsb_minus4
  w.ue(2);                          // max_num_ref_frames
  w.u1(0);                          // gaps_in_frame_num_value_allowed_flag
  w.ue(119);                        // pic_width_in_mbs_minus1 → 1920
  w.ue(picHeightInMapUnitsMinus1);
  w.u1(frameMbsOnly ? 1 : 0);
  if (!frameMbsOnly) w.u1(0);       // mb_adaptive_frame_field_flag
  w.u1(1);                          // direct_8x8_inference_flag
  w.u1(0);                          // frame_cropping_flag = 0 (Chrome's omission)
  w.u1(vuiPresent ? 1 : 0);         // vui_parameters_present_flag
  for (const b of tail) w.u1(b);    // stand-in for VUI body
  w.u1(1);                          // rbsp_stop_one_bit
  const payload = w.bytes();
  const out = new Uint8Array(payload.length + 1);
  out[0] = 0x67;                    // nal_ref_idc=3, type=7 (SPS)
  out.set(payload, 1);
  return out;
}

describe('addSpsFrameCropping', () => {
  it('injects frame_cropping into a 1920×1088 progressive SPS → display 1920×1080', () => {
    const sps = buildFullSps();
    const before = parseSpsPocInfo(sps)!;
    expect([before.codedWidth, before.codedHeight]).toEqual([1920, 1088]);
    expect([before.displayWidth, before.displayHeight]).toEqual([1920, 1088]); // no crop yet

    const out = addSpsFrameCropping(sps, 1920, 1088, 1920, 1080);
    expect(out).not.toBeNull();
    const after = parseSpsPocInfo(out!)!;
    expect([after.codedWidth, after.codedHeight]).toEqual([1920, 1088]);
    expect([after.displayWidth, after.displayHeight]).toEqual([1920, 1080]);
    // POC fields must survive the rewrite unchanged (they precede the crop fields).
    expect(after.log2MaxFrameNum).toBe(before.log2MaxFrameNum);
    expect(after.picOrderCntType).toBe(before.picOrderCntType);
    expect(after.log2MaxPicOrderCntLsb).toBe(before.log2MaxPicOrderCntLsb);
  });

  it('returns the SPS unchanged when coded == display (no crop needed)', () => {
    const sps = buildFullSps();
    expect(addSpsFrameCropping(sps, 1920, 1088, 1920, 1088)).toBe(sps);
  });

  it('preserves the vui_parameters_present_flag and trailing VUI bits after the injected crop', () => {
    const tail = [1, 0, 1, 1, 0, 0, 1, 0]; // distinctive stand-in VUI payload
    const sps = buildFullSps({ vuiPresent: true, tail });
    const out = addSpsFrameCropping(sps, 1920, 1088, 1920, 1080)!;

    // Re-walk the rewritten RBSP to the crop fields, then assert the preserved tail follows.
    const r = new BitReader(stripEmulationPrevention(out, true));
    r.u(8); r.u(8); r.u(8); r.ue();      // profile, constraints, level, sps_id
    r.ue(); r.ue(); r.ue();              // log2_max_frame_num, poc_type, log2_max_poc_lsb
    r.ue(); r.u1(); r.ue(); r.ue();      // max_ref, gaps, width, height
    r.u1();                              // frame_mbs_only_flag
    r.u1();                              // direct_8x8_inference_flag
    expect(r.u1()).toBe(1);              // frame_cropping_flag (now set)
    expect([r.ue(), r.ue(), r.ue(), r.ue()]).toEqual([0, 0, 0, 4]); // L,R,T,B (bottom 1088→1080)
    expect(r.u1()).toBe(1);              // vui_parameters_present_flag (preserved)
    for (const b of tail) expect(r.u1()).toBe(b); // VUI body bits (preserved)
    expect(r.u1()).toBe(1);              // rbsp_stop_one_bit
  });

  it('crops width as well when displayWidth < codedWidth (4:2:0 cropUnitX = 2)', () => {
    const sps = buildFullSps();
    const out = addSpsFrameCropping(sps, 1920, 1088, 1904, 1080)!;
    const after = parseSpsPocInfo(out)!;
    expect(after.displayWidth).toBe(1904);  // 1920 − 2·8
    expect(after.displayHeight).toBe(1080);
  });
});
