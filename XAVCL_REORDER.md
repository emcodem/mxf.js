# XAVC-L Frame Reorder Investigation

## File under test

`MH_0032_XAVCL.mxf` — Atomos Shogun Max, Sony XAVC-L Long-GOP H.264, KAG=512 KB.

## Prior fix (commit `a357dad`)

Corrected essence location: KAG=512 KB places the index at 512 KB and the first essence KLV at exactly 1 MB (the old `ESSENCE_SCAN_WINDOW` upper bound). `MxfFile.locateEssence` now KLV-walks past that boundary, so frames are found and the file plays. This fixed the "no SPS/PPS" FATAL.

## The remaining symptom

Frames play but in wrong display order (visually scrambled video despite the file loading successfully).

## Root cause hypothesis investigated

**`isKeyframeEntry` flag convention mismatch.**

The VBE index for this file uses SMPTE 377M random-access flag convention: bit 7 = 1 means keyframe (I-frame flags = `0xc4`). The original code used the legacy convention: `(flags & 0x80) === 0` (bit 7 = 0 means keyframe). This inverts keyframe detection — I-frames look like non-keyframes and vice versa.

Cascading effect: `reorder-resolver.ts` uses `isKeyframe` to find GOP heads. With all keyframes mis-detected, GOP boundaries are wrong, display-order reordering produces garbage PTS values.

## Fix applied (`src/parser/index-table.ts`)

Added `segUsesSmpteRandomAccessFlags(seg)` — detects SMPTE RA convention by checking:
- first entry has bit 7 set (`flags & 0x80 !== 0`), AND
- no entry has prediction bits set (`flags & 0x30 === 0` for all)

Updated `isKeyframeEntry` to three-way detection:
1. Tier 1 — prediction flags (ffmpeg path): `(flags & 0x30) === 0`
2. Tier 2 — SMPTE RA (Shogun Max): `(flags & 0x80) !== 0`
3. Tier 3 — legacy fallback: `(flags & 0x80) === 0`

Also fixed three additional raw `(flags & 0x80) === 0` checks that bypassed `isKeyframeEntry`:
- `gopLengthFromKeyframe`
- `resolveFrameOffset`
- `resolveExactFrameOffset`

## Debug logging added and removed

Temporary unconditional `console.log` block in `demux-worker.ts` (gated on `fetchStart <= 2`) confirmed:
- `indexMode = 'vbe'` — VBE index correctly used
- Tier 1 (temporalOffset) active — non-zero temporalOffsets present
- I-frame: `flags=0xc4`, `isKeyframe=true` ✓
- GOP temporal offsets for first 8 frames: 0, +1, +1, -2, +1, +1, -2, +1
- PTS sequence: 0, 2, 3, 1, 5, 6, 4, 8 — correct decode/display split

Logging was removed after confirmation. All 151 unit tests pass. Build clean.

## Current state

Fix is in place but the user reports frames still display in wrong order. Root cause is NOT yet identified.

## What to investigate next

1. **Verify the Tier 1 path reaches `reorder-resolver.ts` with correct data.** Add logging inside `resolveDisplayOrder` or `buildReorderedFrames` to print the raw `inputs` array (temporalOffset, isKeyframe, flags) and the `resolved` array (dts, pts).

2. **Check `hasRealTemporalOffset`** — if it returns false despite non-zero temporalOffsets, the Tier 2 (POC) path runs instead of Tier 1. This would use SPS NAL parsing which may assign wrong display order for this codec variant.

3. **Check fMP4 ctts sign.** `trun` uses version=1 and `setInt32` for signed composition offsets — verify this is correct for negative offsets (B-frames with pts < dts).

4. **Check segment boundary alignment.** If `lgNextFrame` is computed from a wrong GOP length (bad keyframe detection before the fix), the first fetched segment may start mid-GOP — B-frames referencing a prior I-frame that was never decoded. The fix to `isKeyframeEntry` should have corrected this, but verify `resolveFrameOffset` / `resolveExactFrameOffset` return correct `nearestKeyframeEditUnit`.

5. **Check `isBoundary` logic.** If the boundary-leading-B-drop fires incorrectly, the first segment loses frames and MSE sees a gap.

6. **Inspect the raw fMP4 segment** with mp4box or similar to confirm dts/pts values on individual samples.
