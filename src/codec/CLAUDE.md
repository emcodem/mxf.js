# src/codec/ — MPEG-2 decoder + transcoder traps

## Chrome VideoEncoder SPS constraint flags (`mpeg2-transcoder.ts`)

Chrome's `VideoEncoder` sets `constraint_set4_flag` and `constraint_set5_flag` (bits 3–2 of `SPS[2]`) even for Main Profile — both wrong for a predictive stream, causing MSE to reject the init segment. Fix: `sps[2] = sps[2] & 0xc0` after `parseSPSPPSFromAvcC`.

## MPEG-2 decoder invariants (`mpeg2-decoder.ts`)

Ported from jsmpeg (MPEG-1), extended for interlaced 4:2:2 Long-GOP. Non-obvious invariants:

1. **`intra_vlc_format=1`** → use Table B-15 (`DCT_COEFF_B15`), not B-14. B-15 has a distinct 4-bit EOB (`0110` → sentinel `0xFFFE`).
2. **VLC tree builder: missing children must be `-1`, not `0`.** `readHuffman` treats `codeTable[state]===0` as a leaf marker — a `0` child makes an internal node look like a leaf.
3. **DC-size tables go 0–11 for MPEG-2** (not 0–8 like MPEG-1) — `intra_dc_precision>0` requires the extended range.
4. **`dct_type` bit**: in a FRAME picture with `frame_pred_frame_dct==0`, every intra/pattern MB has a 1-bit `dct_type` in `macroblock_modes`. For field-DCT luma, 8 rows are de-interleaved across fields. **4:2:2 chroma is ALSO field-organized** in field-DCT MBs (ISO 13818-2 6.1.3, Fig 6-14): it has two blocks/component spanning 16 lines, so block 4/5 = top field, block 6/7 = bottom field, line-interleaved (`scan=(hw<<1)-8`). Only 4:2:0 chroma (one 8-line block) stays frame-organized. Writing 4:2:2 chroma frame-contiguous scrambled chroma rows in every field-DCT MB → luma perfect, chroma wrong (texture-correlated). Regression: `tests/xdcam-refcompare.test.ts`.
5. **Quant matrices**: chroma has its own intra/non-intra slots (`decodeBlock` selects them for blocks ≥4). **Chroma defaults follow luma** wherever luma is loaded — both in the picture-level `quant_matrix_extension` (ext id `0x03`, parsed even when all load-flags are off) AND in the **sequence header**. XDCAM HD422 loads a custom intra matrix in the sequence header with no chroma matrix and no picture extension; if the sequence-header path doesn't copy luma→chroma, chroma keeps the stale default matrix while luma uses the custom one.
6. **Full-block EOB**: a coefficient at position 63 still emits EOB in MPEG-2. The `if(n>=64) break` stays as corruption guard only.
7. **Dequant scale**: MPEG-2 divides by 32 (`>>5`), MPEG-1 by 16 (`>>4`).
8. **DC predictor chroma block assignment**: even chroma blocks (4, 6) → `dcPredictorCb`; odd (5, 7) → `dcPredictorCr`. Swapping causes wrong chroma DC in every macroblock after the first in each slice.

**`MACROBLOCK_ADDRESS_INCREMENT` VLC** must be built from canonical FFmpeg data (`ff_mpeg12_mbAddrIncrTable`), not hand-authored — the jsmpeg table decoded `00000`→increment 7 (invalid), desyncing every inter slice.

**Known limitation**: `predictField`/dual-prime MC paths exist but are unverified on real field-MC/dual-prime content.

**Open-GOP scrub**: after `reset()`, `suppressUntilKeyframe` discards emitted frames until the I-frame — open-GOP leading B's reference the prior GOP's anchor and produce garbage otherwise. Reference buffers blanked to neutral grey (Y=0, chroma=128). `heldAnchorIsKeyframe` tracks the held I-anchor's keyframe flag separately from the current picture type at emit time. Regression: `tests/xdcam-scrub-repro.test.ts`.

**Debug tooling**: `test/e2e/debug.html` + `test/e2e/yuv-debug.test.ts` — decodes N frames, renders a montage, loads `C:/temp/mxf.js/ref.yuv` as reference. `Mpeg2Decoder.debugInfo()` exposes slice/MB/DCT stats. VLC/DC trees self-test at load (Kraft sum, round-trip).
