# BITEXACT — MPEG-2 decode: reaching FFmpeg-identical output

## Status: BIT-EXACT ✅

The decoder is now byte-identical to the scalar `-cpuflags 0 -flags +bitexact -idct simple`
reference across all 120 test frames (I, P, and B), on **both** the pure-JS path and the WASM-kernel
path:

| | original | after all fixes |
|---|---|---|
| worstLumaMae | 0.009 | **0** |
| worstChromaMae | 0.141 | **0** |
| per-pixel max diff | 1–2 | **0** |
| bad pixels (diff > 20) | 0 | 0 |

`tests/xdcam-refcompare.test.ts` now asserts exact `0` (mae and max). Three distinct bugs were
fixed to get here — two in MC/mismatch, one in the IDCT itself:

**Root cause (the dominant chroma error): MPEG-2 mismatch control vs the DC-only fast path.**
MPEG-2 mismatch control (`mpeg2-decoder.ts:1857-1860`) toggles `blockData[63] ^= 1` whenever the
coefficient sum is even — so a block that decoded with *only* the DC coefficient is no longer
DC-only: it carries an `F[7][7]=±1`. The DC-only fast path was selected on `n === 1` alone and ran
`dcOnlyPixel(DC)`, silently dropping that mismatch coefficient. FFmpeg always runs the full IDCT in
this case. Rare in I-frames (intra blocks almost always have AC), but very common in **inter chroma**
residuals (smooth → frequently DC-only), which is exactly why the error was ~15× larger in chroma
and accumulated through P/B frames. **Fix:** gate the fast path on `n === 1 && blockData[63] === 0`
(JS intra/inter branches + the WASM `k.dcBlock` branch); when mismatch set `[63]`, fall through to
the full `idct()`. This is *not* the same as A.2's finding — `dcOnlyPixel` itself is correct (A.2
proved it); the bug was *selecting* it for a block that mismatch had made non-DC-only.

**Second & third bugs — IDCT not replicating ff_simple_idct exactly (the final ±1).** After the
first fix a ~0.005 chroma residual remained, always exactly **−1**, present even in the pure I-frame
(intra, no MC) in **textured** blocks, then amplified through MC accumulation (worst frames latest).
Localized by per-MB MC attribution (the bias survived into full-pel copies → propagation, not a
single MC path) and confirmed against `libavcodec/simple_idct_template.c`. Our IDCT port always ran
the full butterfly, but `ff_simple_idct_int16_8bit` has two arithmetic details we didn't match:
1. **Row DC-only shortcut**: for a row whose AC terms are all zero, ffmpeg broadcasts
   `(row[0] << 3) & 0xffff` (DC_SHIFT=3, int16-truncated), NOT the full `(W4*row[0]+1024)>>11` — these
   differ by ±1 for `row[0] > 1024` (large intra DC); our full path came out lower → −1.
2. **Column rounding constant**: ffmpeg's column DC term is `W4*(c0 + (1<<19)/W4)` = `W4*(c0+32)`
   = `W4*c0 + 524256`, NOT the exact `+524288`. (This is exactly the `COL_DC_BIAS=32` the WASM kernel
   already used — the WASM had the *column* right all along; the JS oracle had the
   imprecise-but-canonical constant wrong, and an interim "fix" to 524288 made it worse.)

**Fix:** add the row DC-only `<<3` shortcut and use `W4*(c0+32)` column rounding in **both** `idct()`
and the WASM `idctCore`; set `dcOnlyPixel()` to `colPass(row[0]<<3)` (A.2 consistency preserved);
`npm run asbuild`. Result: every frame mae=0, max=0, on JS and WASM; `tests/wasm-plane-parity.test.ts`
hashes match. This was the last bug — the decoder is bit-exact.

A previous session declared this "DONE" and blamed the residual chroma error on "inherent
JS-vs-C integer rounding." **That is wrong.** In the dequant line
(`mpeg2-decoder.ts:1840`) the product `level * qs * quantMatrix[...]` is at most
~`2047*112*255 ≈ 5.8e7`, well inside the 2^53 exact-integer range of a JS double, so
`/ (1<<shift) | 0` truncates *identically* to C integer division. Luma and chroma share the
same dequant line, the same `idct()`, and the same MC rounding helpers — so a chroma error 15×
larger than luma is a real defect in something chroma exercises disproportionately, not
arithmetic noise. **Bit-exactness (per-plane MAE=0, max=0, bad=0) should be reachable.**

---

## Plan to reach bit-exactness

### Guiding facts (established by code review)

- Quant-matrix parsing is complete: picture `quant_matrix_extension` consumes all four load
  flags incl. chroma (`:1035-1041`); sequence header copies luma→chroma when no chroma matrix is
  loaded (`:799-800`, `:1027-1028`). No bitstream desync.
- Chroma MV derivation looks correct: 4:2:2 halves horizontal only — frame path `:1609-1632`,
  field path `:1469-1475` (`cmvv = is422 ? mvv : (mvv/2|0)`).
- MC rounding helpers structurally identical to luma (`+1>>1`, `+2>>2`, bidir `(a+b+1)>>1`).
- Test file is **1080i** → the field-MC path (`predictField`, `:1466-1522`) is exercised, and
  `src/codec/CLAUDE.md` flags field/dual-prime MC as **"unverified on real content."**
- DC-only blocks use a fast path `dcOnlyPixel()` (`:1942-1945`) instead of full `idct()`. Chroma
  is smoother → DC-only blocks are disproportionately chroma → any off-by-one in `dcOnlyPixel`
  vs the real IDCT surfaces mostly in chroma. **Prime suspect.**

### Phase A — Make the comparison sound (do first; cheap)

1. **Regenerate the reference with a guaranteed-scalar FFmpeg IDCT.** `-idct simple` may dispatch
   to SIMD that isn't bit-identical to the C `ff_simple_idct_int16_8bit` we ported. Force the C
   path + bitexact:
   ```powershell
   ffmpeg -y -cpuflags 0 -flags +bitexact -idct simple `
     -i media/xdcamhd_1920_25i_16tracks.mxf -frames:v 120 `
     -pix_fmt yuv422p -f rawvideo C:/temp/xdcam_ref422.yuv
   ```
   Until the reference is provably from the same algorithm, we can't separate "our bug" from
   "SIMD-vs-C reference noise."
2. **Self-consistency unit test for `dcOnlyPixel` (no FFmpeg needed).** Assert
   `dcOnlyPixel(dc) === idct(blockWithOnly[0]=dc)` over the full intra-DC range
   (`intraDcPrecision=2`). If they differ, `dcOnlyPixel` is inconsistent with the decoder's own
   IDCT — a definite bug; fix by deriving it to match `idct()` (or delete the fast path).
   New test: `tests/idct-dc-consistency.test.ts` (pure, CI-safe, no media).

### Phase B — Localize: intra vs inter (decisive fork)

3. **Measure frame-0 (pure I-frame) chroma vs luma error separately** — no MC, isolates the intra
   pipeline. Surface frame-0 `yc/uc/vc` distinctly in `tests/xdcam-refcompare.test.ts`.
   - frame-0 chroma `mae ≈ 0` → all 0.141 is MC accumulation → **Phase D**.
   - frame-0 chroma `mae > 0` and `> luma` → intra chroma bug → **Phase C**.

### Phase C — Intra chroma bug hunt (if Phase B points here)

4. **Compare all 64 chroma intra-matrix values to FFmpeg's** (prior session checked only first 8,
   and only our-luma-vs-our-chroma, never vs FFmpeg). Add full 64-entry matrix to `debugInfo()`.
5. **Disable `dcOnlyPixel` (force full `idct()` for `n===1`) and re-measure.** If chroma drops,
   A.2 already located it — fix `dcOnlyPixel`.
6. **Diff one I-frame chroma block's dequantized coefficients** vs FFmpeg to find the exact
   divergent coefficient if 4–5 don't explain it.

### Phase D — Inter chroma bug hunt (if Phase B points here)

7. **Find the first diverging frame and its picture type** (expose `pictureType` on `YUVFrame`
   or infer from emit order). Localizing to P-only vs B-only narrows the path.
8. **Audit field-MC chroma vs ISO 13818-2 §7.6.4** (`predictField`, `:1466-1522`) — the
   "unverified" path this interlaced file uses. Check field-line addressing/parity
   (`srcParity`/`dstParity`, `r0=(fieldLine<<1)+srcParity`, vertical half-pel `r1=r0+2`) and
   `fieldSelect`. Cross-check FFmpeg `-debug mv`.
9. **Audit bidirectional averaging order** (`:1518-1519`, `:1737-1743`): each uni-prediction
   rounded then `(fwd+bwd+1)>>1`, matching FFmpeg (no double-rounding).

### Phase E — Converge & document honestly

10. Iterate until `bad=0`, per-plane `max=0`, `mae=0` on the scalar reference.
11. Tighten `tests/xdcam-refcompare.test.ts` thresholds to exact `0` (or document any provably
    irreducible ±0 with the specific reason).
12. Update this file + `src/codec/CLAUDE.md` with the true root cause.

### Critical files

| File | Role |
|---|---|
| `src/codec/mpeg2-decoder.ts` | dequant `:1834-1850`; `idct`/`dcOnlyPixel` `:1942-2004`; field MC `:1466-1522`; frame MC `:1526+`; bidir `:1737-1743`; quant-matrix parse `:1024-1043`,`:793-804`; `debugInfo()` `:728-746` |
| `tests/xdcam-refcompare.test.ts` | MAE harness; add frame-0 split + first-divergence log; tighten thresholds |
| `tests/idct-dc-consistency.test.ts` (new) | `dcOnlyPixel` vs `idct()` self-consistency |

### Verification

- `npx vitest run tests/idct-dc-consistency.test.ts` passes.
- Regenerate scalar reference (A.1), then `npx vitest run tests/xdcam-refcompare.test.ts` →
  target `worstLumaMae=0`, `worstChromaMae=0`, no bad pixels, per-plane `max=0`.
- `npm run typecheck` clean.

### Stop condition

If, after a sound scalar reference, an irreducible ±0–1 remains and is *proven* to come from a
documented FFmpeg-specific quirk (not our code), that is the only acceptable place to stop — and
it must be documented with the specific reason, never hand-waved as "inherent rounding."

---

## Fixes already applied (chronological)

1. **Chroma MV floor-vs-trunc**: `motion_x / 2` used `>> 1` (floor) for negative odd values.
   Fixed to truncation-toward-zero in four call sites.
2. **IDCT algorithm**: AAN IDCT → `ff_simple_idct_int16_8bit` (W1=22725…W7=4520, ROW_SHIFT=11,
   COL_SHIFT=20). DC scaling `<< (3-prec)`, mismatch XOR `^= 1`.
3. **Field-DCT 4:2:2 chroma organization**: blocks 4/5 = top field, 6/7 = bottom field
   (ISO 13818-2 Fig 6-14). Frame-contiguous write scrambled chroma rows.
4. **Quant matrix chroma inheritance**: sequence-header custom luma matrix now copied to chroma.
5. **B-frame inter-prediction**: bad pixels (up to 247) in B-frame odd rows / MB row 65 fixed.
6. **Non-intra dequant truncation**: `>> 5` (floor) → `(level*qs*W/32)|0` (trunc toward zero),
   matching FFmpeg's sign-magnitude path. Dropped luma MAE from 0.439 to 0.009.

## Phase A results (comparison now sound)

- **A.1 — scalar reference regenerated** (`-cpuflags 0 -flags +bitexact -idct simple`, 160 frames):
  produces **identical** numbers to the old reference — `worstLumaMae=0.009`,
  `worstChromaMae=0.141`, bad=0. So the residual is NOT SIMD-vs-C reference noise; it is a real
  decoder defect. This is the trusted baseline for Phase B.
- **A.2 — `dcOnlyPixel` self-consistency test passes** (`tests/idct-dc-consistency.test.ts`, pure/
  CI-safe): all 64 `idct()` outputs equal `dcOnlyPixel(dc)` over `dc ∈ [-4096, 4096]`. The DC-only
  fast path is algebraically identical to the full IDCT → **`dcOnlyPixel` is exonerated**, not the
  chroma bug.
- **B — intra/inter fork (DECISIVE)**: frame-0 / first-I-frame stats vs scalar ref —
  `Y mae=0.0002 max=1`, `U mae=0.0000 max=1`, `V mae=0.0001 max=1`, bad=0. The intra pipeline is
  essentially bit-exact (a few stray ±1 px, mae≈0). Therefore the `chroma=0.141` residual is
  **NOT intra** — it accumulates through **motion compensation** (worst frame is #100, late in the
  sequence → MC drift across the GOP). **Skip Phase C; go to Phase D (inter/field-MC chroma).**
  Surfaced via `tests/xdcam-refcompare.test.ts` ("Phase B intra/inter fork" log block).
- **D — inter chroma root cause (FIXED)**: split error by picture type — P and B carry ~equal
  chroma error (0.135/0.141) → **not** bidir averaging (D.9 ruled out). Error is purely ±1,
  parity-independent. Traced to the **mismatch-control + DC-only fast-path** interaction (see
  Status block above). Fix gates `dcOnlyPixel` on `blockData[63] === 0`. Result: chroma
  0.141→0.005, luma 0.009→0.0003. Picture-type plumbing added: `YUVFrame.pictureType` (1=I,2=P,3=B).
- **E — final ±1 eliminated (BIT-EXACT)**: the residual 0.005 was the IDCT not matching
  ff_simple_idct's row DC-only `<<3` shortcut + `W4*(c0+32)` column rounding (see Status block).
  Fixed in `idct()`, `dcOnlyPixel()`, and the WASM `idctCore`. All frames now mae=0, max=0; the
  refcompare thresholds are tightened to exact `0`.

## Ruled out

- IDCT (AAN→simple), chroma MV rounding, field-DCT 4:2:2 layout, quant-matrix chroma
  inheritance, DC predictor Cb/Cr assignment (even→Cb, odd→Cr), B-frame display reordering.
- **SIMD-vs-C reference noise** (Phase A.1): scalar bitexact reference gives identical residual.
- **`dcOnlyPixel` fast path** (Phase A.2): proven consistent with `idct()` by unit test.
- Intra ±1 dequant: adding ±1 to intra → worstLumaMae=4.521. Intra must NOT have ±1.
- Chroma DC predictor block threshold: `block & 1` is correct for 4:2:2 (blocks 4,5,6,7 =
  Cb-top, Cr-top, Cb-bottom, Cr-bottom).
