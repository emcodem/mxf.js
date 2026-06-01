# MPEG-2 P/B-frame decode — handover

> **RESOLVED 2026-05-31.** All 12 frames of `vistek.mxf` now match the ffmpeg reference
> (meanY 0.04–0.08). Root cause was the hand-authored `MACROBLOCK_ADDRESS_INCREMENT`
> (Table B-1) VLC tree, which decoded `00000`→increment 7 (an impossible B-1 prefix code).
> The I-frame only uses `inc=1`, so it stayed latent until P/B. Fixed by rebuilding
> `MACROBLOCK_ADDRESS_INCREMENT` + `MACROBLOCK_TYPE_INTRA/_PREDICTIVE/_B` from canonical
> FFmpeg data (`mpeg12data.c` `ff_mpeg12_mbAddrIncrTable`; `mpeg12.c` `table_mb_ptype`/
> `table_mb_btype`) via `_buildLeafTree` with Kraft + round-trip self-tests.
> NOTE: `vistek.mxf` uses only frame-MC — no dual-prime/field-MC. Those decoder paths
> (`predictField`, dual-prime) remain UNVERIFIED on content that actually uses them.
> Open: minor localized chroma band (`(r18,c59):130`); `npm run typecheck` still pending.
> The analysis below is the original (pre-fix) handover, kept for context.

Status as of this session. Goal: make the MPEG-2 decoder (`src/codec/mpeg2-decoder.ts`)
decode **P and B frames** (Long-GOP), not just I-frames. The target stream is
`C:/temp/mxf.js/vistek.mxf` — 1080i50, 4:2:2, frame pictures (`picture_structure==3`),
`frame_pred_frame_dct==0`, `intra_vlc_format==1`, `q_scale_type==1`, `alternate_scan==1`,
open-GOP, and it **uses dual-prime and field-based prediction in P/B frames**.

## TL;DR of current state

- **I-frame: pixel-perfect** (refdiff meanY = 0.04 vs ffmpeg reference). Intra path
  (IDCT, dequant, DC prediction, field-DCT, 4:2:2 block layout, B-15 coeff table) is solid.
- **P/B frames: still desyncing.** A bitstream desync starts partway through each inter
  slice and corrupts the rest of that MB row (slices resync at the next row's start code).
  This shows as horizontal speckle bands; refdiff meanY for inter frames is ~1.5–20
  (should be ~0–2). Leading open-GOP B-frames (#0/#1) are *expected* garbage when feeding
  from frame 0 (their past anchor is in the previous GOP, not in the buffer).
- Trajectory this session (refdiff `vs ref#N`, lower=better): I-frame 0.04 (perfect);
  P#5 ~1.8; B#6/#7 improved 5.1→3.5 / 7.4→4.1; P#8 still ~19.6; B#11 10.1→7.3.

## What was implemented this session (in `src/codec/mpeg2-decoder.ts`)

All under `if (this.isMPEG2)`; the MPEG-1 path is untouched.

1. **Inter-prediction state**: `PMV[r][s][t]`, `fieldSelect[r][s]`, `mvCount`,
   `mvFormatField`, `mvScale`, `dmv`, `concealmentMotionVectors`, `dbgMotionType`.
2. **`readMotionType()`** — parses `frame_motion_type`/`field_motion_type` (Tables 6-17/6-18)
   in the correct bitstream position (BEFORE `dct_type`). This was the original gap:
   `frame_motion_type` (2 bits) was never read, desyncing every inter MB with motion.
3. **MV reconstruction** (`readMotionVectors`/`decodeMV`/`decodeMVComponent`) per ISO 7.6.3,
   incl. PMV prediction, range fold, single-MV→both-predictors copy (7.6.3.5), and the
   field-in-frame vertical predictor `>>1`/`<<1` scaling.
4. **`readDmvector()`** + dmvector consumption for dual-prime (verified identical to
   FFmpeg `get_dmv`).
5. **`predictField()`** — scalar field-based MC for frame pictures (top/bottom field from
   the selected reference field, half-pel luma + 4:2:2/4:2:0 chroma, write/blend modes).
6. **Dual-prime prediction** — currently an *approximation*: same-parity field prediction
   (top←top, bottom←bottom) with the single decoded vector. Exact for the dmv=0/static
   case; full dual-prime averaging-with-opposite-field is TODO.
7. **Skipped-MB handling** for MPEG-2 P (zero-MV) and B (repeat previous mode/MVs).
8. **No-MC P macroblock** fix: a P MB with `macroblock_motion_forward==0` (type `0x02`)
   has NO motion vectors — don't call `readMotionVectors`; reset PMV.
9. **VLC tables rebuilt from canonical FFmpeg data** with Kraft + round-trip self-tests,
   replacing the hand-authored jsmpeg trees (which had transcription errors only hit by
   inter blocks):
   - `DCT_COEFF` (B-14 / `ff_mpeg1_vlc_table`, `_B14_VLCS_NEXT`) via `_buildVlcTree`.
   - `CODE_BLOCK_PATTERN` (Table B-9 / `ff_mpeg12_mbPatTable`, `_CBP_TAB`) via `_buildLeafTree`.
   - `MOTION` (Table B-10 / `ff_mpeg12_mbMotionVectorTable`, `_MV_MAG`) via `_buildLeafTree`.
   - Coefficient decode now unifies EOB to the leaf `0xFFFE` and adds `dct_coeff_first`
     (`'1s'`) handling for the first coefficient of a non-intra block.

## CRITICAL: kraft < 1.0 is NORMAL — do NOT chase it

The self-test logs `kraft` for each table. **MPEG VLC tables are NOT complete prefix codes** —
they have reserved/unused codewords, so kraft < 1.0 is expected and benign:
- B-15 (`DCT_COEFF_1`): kraft 0.997803, 10 dead children
- B-14 (`DCT_COEFF`): kraft 0.999756, 1 dead child
- CBP: kraft 0.998047
- MOTION: kraft 0.988281

A `COEFF/CBP/MOTION deadend` in the debug log means we hit a reserved codeword, i.e. we are
**already misaligned upstream** — the dead-end is a *symptom*, not the cause. (Earlier this
session a lot of time was lost treating B-14's kraft deficit as the bug; it is not.)

## The remaining bug — where it is

The first desync (per `[deadends]`) is `COEFF deadend @r0c22 blk2 n1`. The `c22b2` bit dump
shows its 2nd coefficient is the reserved codeword `000000000000`, so **c22 inherits
misalignment from upstream**. In the first P picture, row 0, the relevant MBs are:
`c0 (frame MC, mt2)` → skip → `c7 (DUAL-PRIME, mt3, coded cbp=0xfb)` → skip(inc 15) → `c22`.

Prime suspects (all unverified by the all-intra I-frame):
1. **`MACROBLOCK_ADDRESS_INCREMENT`** — I-frame only ever uses `inc=1` (`'1'`); P/B use
   7/14/15… so the longer Table B-1 codes are unverified. **Rebuild from FFmpeg
   `ff_mbAddrIncrTable` with a self-test** (next concrete step).
2. **`MACROBLOCK_TYPE_PREDICTIVE` / `MACROBLOCK_TYPE_B`** — inter-only (Tables B-3/B-4).
   Rebuild from FFmpeg.
3. **Dual-prime (`c7`)** — dmvector reading matches FFmpeg, but dump `c7`'s full bit
   consumption to confirm (the desync is between c7 and c22).

The pattern is clear and worked twice (MOTION, CBP): **rebuild every inter VLC table from
canonical FFmpeg data with a Kraft + round-trip self-test.** That removes all
transcription-error suspects; if a desync still remains it must be in the new
MV/dmvector/prediction logic, which can then be dumped per-MB.

## Verification harness (keep until P/B is correct, then strip the `dbg*`)

- Run: `$env:TEST_MXF_FILE="C:/temp/mxf.js/vistek.mxf"; npm run test:e2e`
  (Puppeteer + system Chrome; loads `demo/debug.html`, decodes 12 frames, writes
  `debug-montage.png` and `debug-yuv.png`.)
- `frames.yuv` (12-frame yuv422p ffmpeg reference) is in the project root; `demo/debug.html`
  auto-fetches `/frames.yuv` and logs per-frame `[refdiff] emitted #N … vs ref#N: meanY`.
  Emit↔display map (open GOP, fed in decode order): emitted = [B0,B1,**I**2,B3,B4,P5,B6,B7,
  P8,B9,B10,P11] in *display* frame numbers; emitted #2 is the I-frame.
- Console diagnostics added to the decoder (`debugInfo()` → `demo/debug.html`):
  `[mc] motion types` (frameMc/fieldMc/dualPrime/fpfd counts), `[pictrace]` (per-MB
  type/motion_type/cbp + per-slice mbCount with `CAPPED(overrun)` = desync), `[deadends]`
  (first VLC dead-ends with location: `MBTYPE`/`COEFF`/`CBP`/`MOTION`), and the per-coeff
  `>>> cNNbM` bit dump (currently enabled for the first P picture, c22).
- A safety cap stops a desynced slice at `mbWidth` MBs (a slice can't exceed one row) so it
  resyncs at the next slice instead of bleeding into later rows.

## Canonical FFmpeg tables already fetched (libavcodec/mpeg12data.c, LGPL)

- `ff_mpeg1_vlc_table` (B-14), `ff_mpeg12_run`, `ff_mpeg12_level` — used (`_B14_VLCS_NEXT`).
- `ff_mpeg12_mbMotionVectorTable` (B-10) — used (`_MV_MAG`).
- `ff_mpeg12_mbPatTable` (B-9) — used (`_CBP_TAB`).
- STILL NEEDED: `ff_mbAddrIncrTable` (B-1), `ff_mpeg12_*_mb_type`/`ptype`/`btype` (B-2/B-3/B-4).
  Fetch from https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/mpeg12data.c

## Files touched
- `src/codec/mpeg2-decoder.ts` — all decoder changes + debug instrumentation.
- `demo/debug.html` — refdiff against `frames.yuv`, motion-type/pictrace/deadends logging.

## Notes / gotchas
- The Bash/PowerShell safety classifier was unavailable for most of the session, so the
  human ran `npm run test:e2e` and pasted output. `npm run typecheck` has NOT been run on
  the latest edits — run it first thing.
- `tsconfig` has `noUnusedLocals: true` — don't leave dead consts; replace, don't rename.
- Dual-prime is genuinely present in this stream's P-frames (`mt3` decodes cleanly after
  aligned `macroblock_type`). `mt0`/`mt3` appearing in B-frames in the trace are garbage
  from the desync (those values are reserved/invalid for B).
