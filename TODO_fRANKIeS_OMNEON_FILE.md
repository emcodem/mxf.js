# Fix scrub freeze in second half of multi-partition MPEG-2 Long-GOP files

## Context

`C:/temp/mxf.js/PAT05732.mxf` scrubs smoothly in roughly the first third and shows **freeze frames** when scrubbing past that point. The file is a 3.5 GB **MPEG-2 Long-GOP** (GOP 12, B-frames) OP1a clip whose essence spans **3 body partitions**, each carrying its own **incremental index table** with *global* edit-unit numbering:

| Partition | file offset | bodyOffset | essence start | index segs cover EU | per-partition `indexByteCount` |
|---|---|---|---|---|---|
| 1 (header region) | 0 | 0 | 184459 | 0 - 14999 | (in header) |
| 2 | 1 269 487 226 | 1 269 302 767 | 1 269 653 635 | 15000 - 29999 | 166 237 (~162 KB) |
| 3 | 2 539 228 975 | 2 538 878 107 | 2 539 395 384 | 30000 - 42000 | 166 237 |

The full index covers ~42 001 edit units, but **only partition 1's (0-14999) is ever loaded**.

### Root cause
`MxfFile.collectMultiPartitionIndex` (`src/mxf-file.ts:353`) reads only `WINDOW = 64 * 1024` bytes per body partition (line 358). Each partition's index region is ~166 KB and its first essence element sits at +166 409 - both past the 64 KB window. So:
- `parseIndexTableSegment` fails on the over-long segment value (it needs `valueOffset + valueLength` bytes present) -> the segment is dropped, and
- the walk never reaches a Generic Container element -> `essenceFileStart < 0 -> continue` skips the whole partition (no remap entry recorded).

Result: `indexSegments` covers EU 0-14999 only; partitions 2 & 3 contribute nothing. The method's own comment (line 351) still says *"one ~256 KB read per body partition"* - the `WINDOW` was shrunk to 64 KB (a bootstrap-speed change) and that regressed any file whose per-partition index exceeds 64 KB.

### Failure chain (verified by reading the code)
Scrub to EU >= 15000 -> `resolveLongGopKeyframe`/`findKeyframeFloor` (`src/parser/index-table.ts`) find no covering segment -> `resolveKeyframeFor` (`demux-worker.ts:638`) returns the **target frame** (not a keyframe) -> `handleFetchSegment` -> `fetchFramesViaIndex` -> `resolveExactFrameOffset` returns null -> `if (!resolved) return;` (`essence-extractor.ts:97`) yields **no frames** -> MPEG-2 decoder emits nothing -> `<video>` holds the previous picture = **freeze**. Forward playback past EU 15000 stalls identically.

Because `indexStartPosition` is **global** (15000, 30000, ...) and `streamOffset`s are essence-container-relative, simply *reading* the per-partition segments + recording each partition's `{bodyOffset -> essenceFileStart}` is enough - the existing dedup (`mergeIndexSegments`) and streamOffset-remap loop (`mxf-file.ts:147-157`) already do the rest correctly. **No rebasing of start positions is needed.**

## Primary fix - read each index segment at its own self-describing KLV length

Rather than guessing a window size or trusting the partition pack's `indexByteCount`, use the fact that an `IndexTableSegment` **KLV declares its own length** (16-byte key + BER length, always present at the start of the KLV even when the value runs past the read window). When the walk encounters an index segment whose value doesn't fit in the current buffer, read exactly that segment's bytes and parse it. `indexByteCount` is used only as an optional sanity cross-check, never as the source of truth.

Why the current code fails to do this: `readKLV` (`src/core/klv.ts:30-34`) throws when `valueOffset + valueLength > buffer.byteLength`, and `KLVIterator.next()` swallows that as `null`, so the walk in `collectMultiPartitionIndex` hits the oversized segment, gets `null`, and `break`s - dropping the segment and never reaching the essence element. But `decodeBerLength` (already imported by klv.ts) can read the length from the header bytes that ARE in the window.

Changes:
1. Add a header-only KLV read - `readKLVHeader(buffer, offset)` in `src/core/klv.ts` (or a flag on `readKLV`) that returns `{key, valueOffset, valueLength, totalLength}` WITHOUT requiring the value to be resident. Reuses `decodeBerLength`; does not change `readKLV`'s existing throw-on-truncation contract (other callers rely on it).
2. Rework the per-partition walk in `collectMultiPartitionIndex` (`src/mxf-file.ts:353`) to track an absolute file offset and read KLV headers there (reusing the resident PP/window buffer when it already covers the offset, else a small bounded probe read):
   - Generic Container element -> record `essenceFileStart`, stop.
   - Fill -> skip by its `totalLength`.
   - Index segment -> if its value is resident, parse in place; otherwise `fetchRange(klvFileStart, klvFileStart + totalLength - 1)` for exactly that segment and parse the fresh buffer. **Validate** the declared length is sane before reading (`0 < valueLength <= INDEX_SEGMENT_MAX`, e.g. 100 MB; optionally also `<= afterPP + indexByteCount` when `indexByteCount` is set and plausible). Advance by `totalLength`.
   - Anything else / bounded max iterations -> stop.
3. Keep the existing `MAX_SCANS` cap; optionally add a cumulative index-read budget across partitions. Update the stale "256 KB" comment (line 351) to describe the new behaviour.

Properties: normal XDCAM files (tiny per-partition indexes) stay fast - the index fits the initial probe window and is parsed in place with **no** extra reads. Only the rare large-index case (this file: ~166 KB/partition) triggers one targeted read per segment. Robust to a wrong/garbage `indexByteCount`, and a corrupt KLV length is caught by the sanity bound.

After this change, for PAT05732: `partitions` = 3 entries (incl. partition 1, bodyOffset 0 -> essenceFileStart 184459), `indexSegments` tiles EU 0-42000, the existing remap leaves partition-1 offsets as identity and maps partitions 2 & 3 to their real file offsets. Scrub + playback work across the whole file.

## Secondary fix (in scope) - cross-segment keyframe floor

Even with full coverage, the interior segment boundaries that are *not* keyframes (EU 5956, 11912, 20956, 26912, 35956 - verified: their first entry has flags `0x33`/`0x22`, non-key) create an ~8-frame dead zone: `findKeyframeFloor` (`index-table.ts:218`) scans backward only **within** the covering segment, hits `i = 0` without a keyframe (the GOP-head I lives in the *previous* segment), and returns null -> scrub there falls back to target-frame -> glitch/short freeze. The partition-boundary starts (15000, 30000) happen to be keyframes, so this is minor and likely why "first half" still felt fine.

Make `findKeyframeFloor` continue the backward scan into the immediately preceding segment when it reaches the start of the current one without a keyframe (loop to `seg.indexStartPosition - 1`, re-resolve the covering segment, bounded by segment count). This removes the boundary dead zones now that segments genuinely tile. The analogous latent issue in `resolveFrameOffset` (`nearestIdx = entryIdx + keyFrameOffset` going negative across a boundary, line 378-380) is **not** on this file's long-GOP path; leave it unless we choose to harden it too.

## Critical files
- `src/core/klv.ts` - add `readKLVHeader` (header-only KLV read).
- `src/mxf-file.ts` - `collectMultiPartitionIndex` (primary rework). Add `INDEX_SEGMENT_MAX` to `src/core/constants.ts`.
- `src/parser/index-table.ts` - `findKeyframeFloor` (secondary, in scope).

## Verification
1. `npm run typecheck` and `npm test` (existing 31 unit tests stay green).
2. Add a unit/integration test (gated on the file existing, like `tests/xdcam-scrub-repro.test.ts`): after `MxfFile.open()` on PAT05732, assert `indexSegments` cover up to EU 42000 (max `indexStartPosition + indexDuration` ~ 42001) and that `resolveLongGopKeyframe(30000)` returns a keyframe EU near 30000 with a byte offset inside partition 3 (>= 2 539 395 384).
3. `npm run build` (e2e drives the built `dist` bundle), then load PAT05732 in the demo (`npm run dev`) and scrub the **second half**: confirm frames advance - `video.getVideoPlaybackQuality().totalVideoFrames` rises while scrubbing past 50% - and that forward playback continues past the ~10-minute mark instead of stalling.
4. Re-run the probe `node c:\temp\bla1234.js "C:/temp/mxf.js/PAT05732.mxf"` only as reference for expected offsets (not part of the build).
