/**
 * H.264 picture-order-count (POC) parsing + computation, used to reconstruct display order from
 * decode order for Long-GOP (XAVC-L) streams whose MXF index carries no usable `temporalOffset`.
 *
 * Scope is deliberately narrow: walk NAL units in an AVCC access unit, parse the SPS POC fields,
 * the PPS bottom-field flag, and slice headers *only through the POC syntax* (stopping before the
 * ref-pic-list reordering), then run ITU-T H.264 clause 8.2.1 to derive each frame's POC.
 *
 * POC **type 0** is verified end-to-end against a real XAVC-L 1080p50 GOP (closed-GOP IBBP,
 * reorder depth 2, reference-B's present). Types 1 and 2 are implemented per spec but are
 * **unverified on real content** — callers should fall back to decode order if a stream uses them
 * and the result looks wrong (the resolver does exactly this on any parse failure / field picture).
 */
import { BitReader, stripEmulationPrevention } from './bitreader.js';

/** A NAL unit within an AVCC (length-prefixed) access unit. `nal` includes the 1-byte header. */
export interface Nal {
  type: number;   // nal_unit_type (1=non-IDR slice, 5=IDR slice, 7=SPS, 8=PPS, …)
  refIdc: number; // nal_ref_idc (0 = non-reference picture)
  nal: Uint8Array;
}

export interface SpsPocInfo {
  spsId: number;
  profileIdc: number;
  log2MaxFrameNum: number;
  picOrderCntType: number;
  /** Valid when picOrderCntType === 0. */
  log2MaxPicOrderCntLsb: number;
  /** picOrderCntType === 1 fields. */
  deltaPicOrderAlwaysZeroFlag: boolean;
  offsetForNonRefPic: number;
  offsetForTopToBottomField: number;
  offsetForRefFrame: number[];
  frameMbsOnlyFlag: boolean;
  separateColourPlaneFlag: boolean;
  /** Coded (macroblock-aligned, pre-crop) luma dimensions — what Chrome's MSE parser derives from
   *  the SPS, so the avc1 box must declare these. Interlaced (frame_mbs_only_flag=0) codes the full
   *  frame height even when the MXF descriptor stores the per-field height. */
  codedWidth: number;
  codedHeight: number;
  /** Display (cropped) luma dimensions — the coded size minus frame_cropping, i.e. the active
   *  picture (e.g. 1920×1080 from a 1920×1088 coded frame). Equals coded dims when no cropping. */
  displayWidth: number;
  displayHeight: number;
}

export interface PpsPocInfo {
  ppsId: number;
  spsId: number;
  bottomFieldPicOrderInFramePresentFlag: boolean;
}

export interface SliceHeaderPoc {
  nalType: number;
  nalRefIdc: number;
  isIdr: boolean;
  firstMbInSlice: number;
  /** Normalized to 0..4 (0=P, 1=B, 2=I, 3=SP, 4=SI); the +5 "all slices" variants are folded in. */
  sliceType: number;
  ppsId: number;
  frameNum: number;
  fieldPicFlag: boolean;
  bottomFieldFlag: boolean;
  idrPicId: number;
  picOrderCntLsb: number;
  deltaPicOrderCntBottom: number;
  deltaPicOrderCnt: [number, number];
}

const NAL_SLICE_NON_IDR = 1;
const NAL_SLICE_IDR = 5;

/** High-profile idc values that carry the chroma_format_idc … scaling-list prologue in the SPS. */
export const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Walk NAL units in an AVCC (length-prefixed) buffer. lengthSize is the NALU length field size. */
export function* iterNals(avcc: Uint8Array, lengthSize = 4): Generator<Nal> {
  let i = 0;
  const dv = new DataView(avcc.buffer, avcc.byteOffset, avcc.byteLength);
  while (i + lengthSize <= avcc.length) {
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = (len * 256) + dv.getUint8(i + k);
    i += lengthSize;
    if (len <= 0 || i + len > avcc.length) break;
    const nal = avcc.subarray(i, i + len);
    yield { type: nal[0] & 0x1f, refIdc: (nal[0] >> 5) & 0x3, nal };
    i += len;
  }
}

/** True if a NAL type is a coded VCL slice we parse for POC (non-IDR or IDR slice). */
function isVclSlice(type: number): boolean {
  return type === NAL_SLICE_NON_IDR || type === NAL_SLICE_IDR;
}

/** The first coded VCL slice NAL of an access unit, or null if none. */
export function firstSliceNal(avcc: Uint8Array, lengthSize = 4): Nal | null {
  for (const n of iterNals(avcc, lengthSize)) if (isVclSlice(n.type)) return n;
  return null;
}

/** True if the access unit's first coded slice is an IDR (nal_unit_type 5). */
export function isIdrAccessUnit(avcc: Uint8Array, lengthSize = 4): boolean {
  const s = firstSliceNal(avcc, lengthSize);
  return s !== null && s.type === NAL_SLICE_IDR;
}

/** Skip a scaling list of `size` coefficients (used inside the high-profile SPS prologue). */
function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8, nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = r.se();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/** Parse the POC-relevant fields of an SPS NAL. Returns null on failure. */
export function parseSpsPocInfo(spsNALU: Uint8Array): SpsPocInfo | null {
  try {
    const r = new BitReader(stripEmulationPrevention(spsNALU));
    const profileIdc = r.u(8);
    r.u(8);   // constraint flags + reserved
    r.u(8);   // level_idc
    const spsId = r.ue();

    let separateColourPlaneFlag = false;
    let chromaFormatIdc = 1; // default 4:2:0 when not signalled (non-high profiles)
    if (HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColourPlaneFlag = r.u1() === 1;
      r.ue();   // bit_depth_luma_minus8
      r.ue();   // bit_depth_chroma_minus8
      r.u1();   // qpprime_y_zero_transform_bypass_flag
      if (r.u1()) { // seq_scaling_matrix_present_flag
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (r.u1()) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }

    const log2MaxFrameNum = r.ue() + 4;
    const picOrderCntType = r.ue();
    let log2MaxPicOrderCntLsb = 0;
    let deltaPicOrderAlwaysZeroFlag = false;
    let offsetForNonRefPic = 0;
    let offsetForTopToBottomField = 0;
    const offsetForRefFrame: number[] = [];

    if (picOrderCntType === 0) {
      log2MaxPicOrderCntLsb = r.ue() + 4;
    } else if (picOrderCntType === 1) {
      deltaPicOrderAlwaysZeroFlag = r.u1() === 1;
      offsetForNonRefPic = r.se();
      offsetForTopToBottomField = r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) offsetForRefFrame.push(r.se());
    }

    r.ue();   // max_num_ref_frames
    r.u1();   // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = r.ue();
    const picHeightInMapUnitsMinus1 = r.ue();
    const frameMbsOnlyFlag = r.u1() === 1;

    const codedWidth = (picWidthInMbsMinus1 + 1) * 16;
    const codedHeight = (2 - (frameMbsOnlyFlag ? 1 : 0)) * (picHeightInMapUnitsMinus1 + 1) * 16;

    // Continue past frame_mbs_only_flag to read frame_cropping → the active (display) dimensions.
    // Wrapped so a parse miss here never loses the coded dims/POC fields already captured above.
    let displayWidth = codedWidth;
    let displayHeight = codedHeight;
    try {
      if (!frameMbsOnlyFlag) r.u1();   // mb_adaptive_frame_field_flag
      r.u1();                          // direct_8x8_inference_flag
      if (r.u1()) {                    // frame_cropping_flag
        const cropL = r.ue(), cropR = r.ue(), cropT = r.ue(), cropB = r.ue();
        // SubWidthC/SubHeightC per chroma_format_idc (H.264 §6.2, Table 6-1). Monochrome (0) and
        // separate colour planes use luma-grid crop units.
        const mono = chromaFormatIdc === 0 || separateColourPlaneFlag;
        const subW = mono ? 1 : (chromaFormatIdc === 3 ? 1 : 2);              // 4:4:4→1, else 2
        const subH = mono ? 1 : (chromaFormatIdc === 1 ? 2 : 1);             // 4:2:0→2, else 1
        const cropUnitX = subW;
        const cropUnitY = subH * (frameMbsOnlyFlag ? 1 : 2);
        displayWidth  = codedWidth  - cropUnitX * (cropL + cropR);
        displayHeight = codedHeight - cropUnitY * (cropT + cropB);
        if (displayWidth <= 0 || displayWidth > codedWidth)   displayWidth = codedWidth;
        if (displayHeight <= 0 || displayHeight > codedHeight) displayHeight = codedHeight;
      }
    } catch { /* keep coded dims as display dims */ }

    return {
      spsId,
      profileIdc,
      log2MaxFrameNum,
      picOrderCntType,
      log2MaxPicOrderCntLsb,
      deltaPicOrderAlwaysZeroFlag,
      offsetForNonRefPic,
      offsetForTopToBottomField,
      offsetForRefFrame,
      frameMbsOnlyFlag,
      separateColourPlaneFlag,
      codedWidth,
      codedHeight,
      displayWidth,
      displayHeight,
    };
  } catch {
    return null;
  }
}

/** Parse a PPS NAL through the bottom-field POC flag. Returns null on failure. */
export function parsePpsPocInfo(ppsNALU: Uint8Array): PpsPocInfo | null {
  try {
    const r = new BitReader(stripEmulationPrevention(ppsNALU));
    const ppsId = r.ue();
    const spsId = r.ue();
    r.u1();   // entropy_coding_mode_flag
    const bottomFieldPicOrderInFramePresentFlag = r.u1() === 1;
    return { ppsId, spsId, bottomFieldPicOrderInFramePresentFlag };
  } catch {
    return null;
  }
}

/** Build a `ppsId → PpsPocInfo` map from a list of PPS NALUs (skips any that fail to parse). */
export function buildPpsPocMap(ppsNALUs: Uint8Array[]): Map<number, PpsPocInfo> {
  const map = new Map<number, PpsPocInfo>();
  for (const pps of ppsNALUs) {
    const info = parsePpsPocInfo(pps);
    if (info) map.set(info.ppsId, info);
  }
  return map;
}

/**
 * Parse a coded-slice NAL header through the POC syntax only. `sps` supplies the field widths and
 * `ppsFlagMap` the per-PPS bottom-field flag; both come from the in-band parameter sets parsed at
 * init. Returns null on failure.
 */
export function parseSliceHeaderPoc(
  slice: Nal,
  sps: SpsPocInfo,
  ppsFlagMap: Map<number, PpsPocInfo>,
): SliceHeaderPoc | null {
  try {
    const isIdr = slice.type === NAL_SLICE_IDR;
    const r = new BitReader(stripEmulationPrevention(slice.nal));

    const firstMbInSlice = r.ue();
    const sliceType = r.ue() % 5;
    const ppsId = r.ue();
    if (sps.separateColourPlaneFlag) r.u(2); // colour_plane_id

    const frameNum = r.u(sps.log2MaxFrameNum);

    let fieldPicFlag = false;
    let bottomFieldFlag = false;
    if (!sps.frameMbsOnlyFlag) {
      fieldPicFlag = r.u1() === 1;
      if (fieldPicFlag) bottomFieldFlag = r.u1() === 1;
    }

    let idrPicId = 0;
    if (isIdr) idrPicId = r.ue();

    const pps = ppsFlagMap.get(ppsId);
    const bottomFieldPresent = pps?.bottomFieldPicOrderInFramePresentFlag ?? false;

    let picOrderCntLsb = 0;
    let deltaPicOrderCntBottom = 0;
    const deltaPicOrderCnt: [number, number] = [0, 0];

    if (sps.picOrderCntType === 0) {
      picOrderCntLsb = r.u(sps.log2MaxPicOrderCntLsb);
      if (bottomFieldPresent && !fieldPicFlag) deltaPicOrderCntBottom = r.se();
    } else if (sps.picOrderCntType === 1 && !sps.deltaPicOrderAlwaysZeroFlag) {
      deltaPicOrderCnt[0] = r.se();
      if (bottomFieldPresent && !fieldPicFlag) deltaPicOrderCnt[1] = r.se();
    }

    return {
      nalType: slice.type,
      nalRefIdc: slice.refIdc,
      isIdr,
      firstMbInSlice,
      sliceType,
      ppsId,
      frameNum,
      fieldPicFlag,
      bottomFieldFlag,
      idrPicId,
      picOrderCntLsb,
      deltaPicOrderCntBottom,
      deltaPicOrderCnt,
    };
  } catch {
    return null;
  }
}

/**
 * Computes per-frame PicOrderCnt across an access-unit sequence (ITU-T H.264 clause 8.2.1).
 *
 * Call `reset()` at each random-access point (GOP head / IDR) before feeding that GOP's slices in
 * decode order. `computeFrame()` returns the frame POC (min of the two field counts). State for
 * the prediction (`prevPicOrderCntMsb/Lsb` for type 0, `prevFrameNum*` for types 1/2) is updated
 * only as the spec requires — for type 0, **only on reference pictures** (nal_ref_idc != 0), which
 * is what makes reference-B streams reorder correctly.
 */
export class PocComputer {
  private prevPicOrderCntMsb = 0;
  private prevPicOrderCntLsb = 0;
  private prevFrameNumOffset = 0;
  private prevFrameNum = 0;
  private started = false;

  reset(): void {
    this.prevPicOrderCntMsb = 0;
    this.prevPicOrderCntLsb = 0;
    this.prevFrameNumOffset = 0;
    this.prevFrameNum = 0;
    this.started = false;
  }

  /** Returns the frame's PicOrderCnt. Only frame pictures (fieldPicFlag === false) are supported. */
  computeFrame(sh: SliceHeaderPoc, sps: SpsPocInfo): number {
    switch (sps.picOrderCntType) {
      case 0: return this.computeType0(sh, sps);
      case 1: return this.computeType1(sh, sps);
      default: return this.computeType2(sh, sps);
    }
  }

  private computeType0(sh: SliceHeaderPoc, sps: SpsPocInfo): number {
    const maxLsb = 1 << sps.log2MaxPicOrderCntLsb;
    let prevMsb: number;
    let prevLsb: number;
    if (sh.isIdr || !this.started) {
      prevMsb = 0;
      prevLsb = 0;
    } else {
      prevMsb = this.prevPicOrderCntMsb;
      prevLsb = this.prevPicOrderCntLsb;
    }

    const lsb = sh.picOrderCntLsb;
    let picOrderCntMsb: number;
    if (lsb < prevLsb && prevLsb - lsb >= maxLsb / 2) {
      picOrderCntMsb = prevMsb + maxLsb;
    } else if (lsb > prevLsb && lsb - prevLsb > maxLsb / 2) {
      picOrderCntMsb = prevMsb - maxLsb;
    } else {
      picOrderCntMsb = prevMsb;
    }

    const topFieldOrderCnt = picOrderCntMsb + lsb;
    const bottomFieldOrderCnt = topFieldOrderCnt + sh.deltaPicOrderCntBottom;
    const poc = Math.min(topFieldOrderCnt, bottomFieldOrderCnt);

    // Update prediction state only on reference pictures (per spec: prevPicOrderCnt* come from the
    // previous picture that "has nal_ref_idc != 0"). This is essential when B-frames are references.
    if (sh.nalRefIdc !== 0) {
      this.prevPicOrderCntMsb = picOrderCntMsb;
      this.prevPicOrderCntLsb = lsb;
    }
    this.started = true;
    return poc;
  }

  private computeFrameNumOffset(sh: SliceHeaderPoc, sps: SpsPocInfo): number {
    const maxFrameNum = 1 << sps.log2MaxFrameNum;
    let frameNumOffset: number;
    if (sh.isIdr || !this.started) {
      frameNumOffset = 0;
    } else if (this.prevFrameNum > sh.frameNum) {
      frameNumOffset = this.prevFrameNumOffset + maxFrameNum;
    } else {
      frameNumOffset = this.prevFrameNumOffset;
    }
    this.prevFrameNumOffset = frameNumOffset;
    this.prevFrameNum = sh.frameNum;
    this.started = true;
    return frameNumOffset;
  }

  private computeType1(sh: SliceHeaderPoc, sps: SpsPocInfo): number {
    const frameNumOffset = this.computeFrameNumOffset(sh, sps);
    const cycleLen = sps.offsetForRefFrame.length;
    let expectedDeltaPerCycle = 0;
    for (const o of sps.offsetForRefFrame) expectedDeltaPerCycle += o;

    let absFrameNum: number;
    if (cycleLen !== 0) {
      absFrameNum = frameNumOffset + sh.frameNum;
    } else {
      absFrameNum = 0;
    }
    if (sh.nalRefIdc === 0 && absFrameNum > 0) absFrameNum -= 1;

    let expectedPicOrderCnt = 0;
    if (absFrameNum > 0) {
      const picOrderCntCycleCnt = Math.floor((absFrameNum - 1) / cycleLen);
      const frameNumInPicOrderCntCycle = (absFrameNum - 1) % cycleLen;
      expectedPicOrderCnt = picOrderCntCycleCnt * expectedDeltaPerCycle;
      for (let i = 0; i <= frameNumInPicOrderCntCycle; i++) {
        expectedPicOrderCnt += sps.offsetForRefFrame[i];
      }
    }
    if (sh.nalRefIdc === 0) expectedPicOrderCnt += sps.offsetForNonRefPic;

    const top = expectedPicOrderCnt + sh.deltaPicOrderCnt[0];
    const bottom = top + sps.offsetForTopToBottomField + sh.deltaPicOrderCnt[1];
    return Math.min(top, bottom);
  }

  private computeType2(sh: SliceHeaderPoc, sps: SpsPocInfo): number {
    const frameNumOffset = this.computeFrameNumOffset(sh, sps);
    let tempPicOrderCnt: number;
    if (sh.isIdr) {
      tempPicOrderCnt = 0;
    } else if (sh.nalRefIdc === 0) {
      tempPicOrderCnt = 2 * (frameNumOffset + sh.frameNum) - 1;
    } else {
      tempPicOrderCnt = 2 * (frameNumOffset + sh.frameNum);
    }
    return tempPicOrderCnt; // top == bottom for a frame picture
  }
}
