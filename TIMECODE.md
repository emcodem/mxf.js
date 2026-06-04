# Timecode support — implementation notes & current limitations

Status: **partial / works for the common cases**. System Item per-frame TC and computed
Material/Source/File package TC are implemented end-to-end and wired to the rendered frame, but
several edges remain (see **Open items**). This doc is the handoff so the conversation can be cleared.

---

## Goal

Surface the real MXF timecodes and guarantee the displayed TC matches the frame **on screen**:

1. **System Item TC** — per-frame SMPTE 12M timecode in each content package's System Item. The
   authoritative per-frame source TC; **can jump** (discontinuous), so it is NOT a function of the
   frame index.
2. **Computed package TC** — `TimecodeComponent` start timecode in the Material / File / Source
   package timecode tracks. Appears once in the header; running value is computed per frame as
   `startPosition + editUnit`.

Decisions: implement all three; expose all via API, demo shows a **primary** (priority
system → material → source → file) with a source label; lock to the rendered frame via
`requestVideoFrameCallback` with a `timeupdate` fallback.

---

## How it works

**Why it can be frame-accurate by design:** edit units are the native per-frame ID end-to-end and
every fMP4 sample timestamp is edit-unit-derived, so `editUnit = round(mediaTime × fps)` reverse-maps
exactly for any rendered frame. `requestVideoFrameCallback.mediaTime` is the exact composited frame's
time → exact edit unit → look up / compute the TC. `timeupdate` is the fallback (paused / seek-settle
/ browsers without rVFC); both feed `updateTimecode()` deduped by edit unit.

**Computed package TC** = a pure function of the rendered edit unit, so it needs **no pipeline
plumbing** — the player computes it from `currentTime`. Reliable only when the absolute edit unit is
exact (cbg/vbe index modes); flagged `reliable:false` in `none`/percentage mode.

**System Item TC** flows as sparse **anchors** (presentation editUnit → absolute frame count) on
`videoSegment.systemTcAnchors`. The worker emits only anchors that break a linear run (continuous TC
→ ~1 anchor/segment; a jump → a fresh anchor). The player keeps them sorted and resolves a frame's
system TC as nearest-preceding-anchor + offset, formatted at the anchor's base/dropFrame.

**Per-path anchor accuracy:**
- Normal H.264 / D-10 all-I — exact (`editUnit`, no reorder).
- Long-GOP H.264 (XAVC-L incl. 1080p50) — anchored by the source frame's **storage edit unit**.
  The System Item is in the content package in storage (decode) order and its TC counts linearly in
  storage order (`00,00,01,01,02,02…`), so keying anchors by the reordered presentation `pts`
  scrambled it for B-frame streams (non-monotonic SYS TC when stepping through display order). Keying
  by storage `editUnit` keeps the run linear → exact for continuous TC; a real jump lands within the
  decode-reorder distance of its frame (same best-effort as MPEG-2 below).
- MPEG-2 transcode — **best-effort**: one base anchor per segment (earliest source TC at the first
  displayed edit unit), because per-frame TC isn't tracked through the decoder's display reorder.
  Exact for continuous TC; a mid-segment jump is approximate until the next segment re-anchors.

**System Item parsing** (`parseSystemItemTimecode`): the System Metadata Pack may carry two
`0x81`-marked SMPTE-12M timestamps — Creation (earlier, constant) then **User Date/Time** (the
per-frame TC). We scan for `0x81` and take the **LAST** in-range candidate (range-checked, so an
unrecognised layout yields null — never a wrong TC). The `0x80` field/BGF flag in the hours byte
(50p/59.94p: each TC value spans 2 output frames) is masked off.

**Verified on `xavc_l_1080p50.mxf`** (via `scripts/verify-meta.mjs`): User Date at offset 40 reads
`00,00,01,01,02,02…` — correct 25 fps-counted TC, holding 2 frames per value.

---

## Files changed

- `src/parser/timecode.ts` (new) — `Timecode`, `frameCountToTimecode`/`timecodeToFrameCount`
  (exact inverses; standard NTSC drop-frame), `formatTimecode`, `decodeSmpte12mBcd`,
  `parseSystemItemTimecode` (self-validating, last-`0x81`-wins).
- `src/parser/metadata.ts` — `CLASS_TIMECODE_COMPONENT`; `parseTrack` resolves the
  `TimecodeComponent` (walks Sequence `StructuralComponents` 0x1001, or a direct ref) reading
  `0x1501/1502/1503`; adds `MxfTrack.startTimecode` and `MxfMetadata.timecodes` (+ `MxfTimecodeTrack`).
- `src/core/ul.ts` — `isSystemItem` (`0x04` CP / `0x14` GC).
- `src/essence/essence-extractor.ts` — `EssenceFrame.systemTimecode`; parses the System Item and
  attaches the first valid TC of each package to the picture frame (later TC-less system KLVs don't
  clobber it). `tcBase` from the (rounded) video edit rate; defensive if `bootstrap.metadata` absent.
- `src/worker/worker-messages.ts` — `ManifestTimecode`, `TimecodeAnchor`; `manifest.timecodes`;
  `videoSegment.systemTcAnchors`.
- `src/worker/demux-worker.ts` — `buildTcAnchors` (linear compression), `manifestTimecodes`; emits
  anchors on all three video paths.
- `src/mxf-player.ts` — anchor store + merge, rVFC/timeupdate frame-lock, `computeTimecodeBundle`,
  `timecode` event, `currentTimecode` getter, lifecycle resets.
- `src/events.ts` / `src/index.ts` — `timecode` event, `TimecodeBundle`/`TimecodeSource`,
  `ManifestData.timecodes`, public re-exports + timecode util exports.
- `demo/index.html` — monospace TC readout (primary text + `SYS`/`MP`/`SP`/`FP` label, tooltip lists all).
- `scripts/verify-meta.mjs` (new) — dumps each System Item's raw bytes + all `0x81` candidates + chosen.
- `tests/timecode.test.ts` (new) — drop-frame conversions, BCD decode, offset/last-wins, 50p field flag.
- `tests/aspect-ratio.test.ts` — added `timecodes: []` to the metadata fixture.
- `CLAUDE.md` — new "Timecode" section.

---

## Current limitations / assumptions

### "Works half" — open/unconfirmed
- The user reports it "works half." Exact failing case **not yet diagnosed.** Candidate areas to
  check (pick up here): (a) computed Material/Source TC not appearing or mis-valued for this file;
  (b) system TC correct during playback but stale during scrub/seek-back (see anchor eviction below);
  (c) MPEG-2 transcode files showing only a per-segment base anchor; (d) a specific file/format whose
  System Item layout isn't the last-`0x81` shape. **Needs the user to say which half fails**, then
  `verify-meta.mjs` + the demo debug timeline narrow it.

### Base / framerate assumptions (audited)
- **System Item TC display is robust** to base ≠ counting-rate (e.g. base 50 vs 25-counting 50p):
  values come from the BCD, and the anchor round-trip is a consistent inverse, so display is correct.
  *But* the mismatch hurts **anchor compression** — at base 50 a 25-counting TC advances 1 unit per
  2 edit units, so `buildTcAnchors` keeps ~1 anchor/frame instead of 1/segment. Consequence: if you
  seek back to a region whose anchors were evicted (player caps at 4096), `systemTimecodeAt` linearly
  *extrapolates* from an older anchor (wrong for the field structure) until the refetched segment
  delivers fresh anchors — transient.
- **Computed package TC assumes** `RoundedTimecodeBase (0x1502)` ≈ the TC track's `EditRate`, and that
  `StartTimecode (0x1501)` is counted at that base. The video-editUnit → TC-frame map is
  `round(editUnit × tcTrackRate / videoFps)`. Correct for conformant files (incl. 50p with a 25 fps
  TC track); can be 2× off if a file stores base 25 but TC-track editRate 50, or when `0x1502` is
  absent and the editRate fallback ≠ the counting rate.
- **Drop-frame** only for base 30/60 (correct per spec). 59.94p DF round-trips for display even if it
  counts at 30.
- `decodeSmpte12mBcd` masks the frames-tens nibble to 2 bits (max 39) per SMPTE 12M — a stream that
  literally counted frames 0–49 in the frames field would misread (no conformant file does this;
  50p/60p use the field flag, which we handle).

### System Item layout — best effort
- Offsets are not bitmap-parsed; we scan for the `0x81` coding byte and take the last in-range
  candidate, with fixed offsets (40, 23) only as a no-marker fallback. Validated against
  `xavc_l_1080p50.mxf`. **Other encoders / D-10 CP (`key[12]=0x04`) and other XDCAM files still need a
  `verify-meta.mjs` pass** to confirm the chosen value increments. Unknown layout → no system TC.

### Other
- WebCodecs video path posts `videoChunk` (not `videoSegment`), so it carries **no** system anchors;
  computed package TC still works there.
- MPEG-2 transcode per-frame system TC is not threaded through the decoder reorder (one base anchor
  per segment by design).
- `tests` cover the pure timecode utils; the extractor's system-item attach + worker anchor build +
  player wiring are exercised manually (no fixture-based test yet).

---

## Next steps (suggested)

1. **Get the failing "half" reproduced** — which TC source, which file, playback vs scrub — then fix.
2. Run `verify-meta.mjs` on a D-10/IMX file and another XDCAM/XAVC to confirm system-item offsets
   per format; tune `parseSystemItemTimecode` only if a format sits elsewhere.
3. Optional robustness: detect the half-rate field-flag case and set the system anchor base to the
   counting rate (restores compression + fixes evicted-anchor extrapolation).
4. Optional: confirm/adjust the computed-TC base-vs-editRate convention against bmx.
5. Add a fixture-based test for the extractor→worker→player system-anchor path.

## Validate

```
npm run typecheck && npm test && npm run build      # build required before the demo (loads dist/)
node scripts/verify-meta.mjs <file.mxf> [maxFrames]  # dump System Item bytes + candidates
```
