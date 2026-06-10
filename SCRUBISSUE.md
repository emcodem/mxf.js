# Scrub/skip settle-refetch corruption — diagnosis handoff

**Status:** OPEN, not fixed. Root cause narrowed but not pinned. Diagnosed 2026-06-10.
**Sibling bug (FIXED, committed on branch `fix/seek-end-of-clip-clamp`):** seek-to-end off-by-one — see bottom.

---

## Symptom

On the **MPEG-2 transcode path** (XDCAM HD; default demo file `media/xdcamhd_1920_25i_16tracks.mxf`, exactly 10 s / 250 frames), this gesture freezes the picture for ~0.6–1 s on play:

1. Load the default file (paused at 0).
2. `↑` (+10 s) → jumps to the end.
3. `↓` (−10 s) → jumps back to the start (frame 0).
4. Press play.

Observed: audio plays and `video.currentTime` advances normally, but the **picture freezes ~4 frames in** (mediaTime ≈ 0.2 s, frame ~5), stays frozen for ~640–800 ms while the clock runs through to mediaTime ≈ 1.08 s, then **jumps forward (dropping ~8 frames)** and plays normally. The picture recovers **exactly at the next forward segment's IDR**, i.e. the entire first re-fetched H.264 segment `[~2..26]` decodes wrong.

Diagnostics during the freeze:
- `getVideoPlaybackQuality().droppedVideoFrames` climbs (~8); `corruptedVideoFrames` stays **0**.
- `video.buffered` reports **one contiguous range** (no gap).
- No `waiting` event necessarily fires; the element keeps "playing" while the picture is stuck.

## Trigger chain

`↑` jumps to the end → `trimBackBuffer` (`BACK_BUFFER_SECONDS = 6`) evicts the start of the buffer → `↓` to 0 can no longer be served from the buffer (and the Web-Audio store has diverged to the end), so the settle does a **full worker re-seek + refetch**. That refetch runs through the persistent `Mpeg2Pipeline` (decoder) + `Mpeg2Transcoder` (WebCodecs `VideoEncoder`) **right after a scrub preview** ran through the same shared pipeline (`handleScrubPreview` → `transcodePipeline.reset(keyframe, /*useDisplayBase*/ false)` + decode, plus a speculative adjacent-GOP cache-fill).

The first re-encoded forward segment then decodes wrong in the browser, even though it is IDR-led.

## What is RULED OUT (each tested, not speculation)

| Hypothesis | How tested | Result |
|---|---|---|
| **MPEG-2 decoder** state after the preview | Node byte-compare: decode `[0..26]` after the full worker sequence (preview `reset(0,false)`+decode 0..5, flush, speculative `reset(~12)`+decode, settle `reset(0)`) vs a fresh decode of `[0..26]`. `Mpeg2Decoder` is pure JS so this runs in vitest. Modeled on `tests/xdcam-scrub-repro.test.ts`. | **byte-exact** — decoder innocent |
| **Encoder** state (persistent WebCodecs `VideoEncoder` is NOT reset on seek) | Added `recreateEncoder()` (close + reconfigure, keeping `_spspps` so the avcC stays compatible with the init segment) and called it on every accurate seek (`useDisplayBase=true`) in `Mpeg2Pipeline.reset()`. Browser repro. | freeze **UNCHANGED** (~800 ms) → reverted |
| **MSE** overlap / storage-vs-display-order preview pollution | Evicted the whole video SourceBuffer before the settle refetch (`MseController.evict`), so the refetch rebuilds into empty space. Browser repro. | freeze **UNCHANGED** → reverted |
| **Fragmenter** carried-over state | Code review: per-segment `baseMediaDecodeTime = chunks[0].editUnit * frameDurationTicks` is derived from the chunk's own (display-order, monotonic) timestamp. Only `seqNum` (moof sequence counter) persists — harmless. | not the cause |
| Is it the refetch itself? | **Plain `player.seek(0)` refetch** (no preview first), even after genuine back-buffer eviction (played past 6 s so `[0..]` truly evicted, then `seek(0)`), then play. Browser repro. | **CLEAN, zero freeze** |
| Is it inherent cold-start decode? | Baseline: load, pause, `seek(0)`, play — no skip gestures. | **CLEAN, zero freeze**, one contiguous buffer |

**Conclusion:** the trigger is unambiguously "a scrub PREVIEW ran through the shared pipeline before the settle," but the carried-over corruption is **NOT** in the decoder, the encoder, the MSE buffer, or the fragmenter timestamps. The corrupt H.264 segment survives all four candidate fixes.

## Key code references

- `src/worker/demux-worker.ts`
  - `handleScrubPreview` (~878): preview path — `reset(keyframe, false)`, short contiguous decode, speculative adjacent-GOP cache-fill (`cacheOnly` + `resetToFrame`).
  - `handleSeek` (~827): `transcodePipeline.reset(nearestKeyframe)` (default `useDisplayBase=true`), posts `seeked`.
  - `handleFetchSegment` (~500–760): `exact=true` for transcode; persistent decoder fed consecutive frames; held-anchor logic (`flushHeldAnchor = atEndOfStream || keyframePreview || isScrubPreview`).
  - MPEG-2 path created at ~292/323 → `Mpeg2Pipeline` (the JS pipeline — confirmed active for the default file, NOT `WasmTranscodePipeline`).
- `src/worker/mpeg2-pipeline.ts` — `reset(toFrame, useDisplayBase)` resets decoder + counter; `decodeSegment` forces `firstFrameOfSegment` → keyframe per segment; held anchor for B-frame reorder.
- `src/codec/mpeg2-transcoder.ts` — WebCodecs encoder, `latencyMode:'realtime'` (no B-frames, display-order monotonic output), `avc:{format:'avc'}` (avcC via `decoderConfig.description`, captured once).
- `src/remuxer/mp4-fragmenter.ts` — `buildTranscodedVideoSegment` (~283): `baseTime = chunks[0].editUnit * frameDurationTicks`, `compositionTimeOffset: 0`.
- `src/mxf-player.ts` — `initiateSeek` (worker seek), scrub settle callback `(t) => this.initiateSeek(t, 'accurate')`, `maybeResumePlayback` gate (`RESUME_BUFFER_SECONDS = 1.5`), `onTimeUpdate` → `trimBackBuffer`.
- `src/scrub-controller.ts` — drives ↑/↓ skip + slider release; preview→render cycle.

## Worker segment trace (post-fix gesture, for reference)

After `↓` settle, the worker emits (first-chunk `editUnit`):
`0` (preview, 6 frames) · `0` (settle seekChunk, 2 frames) · `2` (forward, 25) · `27` · `52` · …
The browser plays the seekChunk fine, then **freezes through the entire `[2..26]` segment** and recovers at the `27` segment's IDR.

## Reproduction harness

Puppeteer + system Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`, headless `false`), Vite dev server, `demo/index.html?e2e=1` (runs the built `dist` bundle — **rebuild first**). The demo creates the player with `debug:true` so `[mxf.js] gate …` and `[worker] videoSegment …` lines print to the console (capture worker console via `target.worker()`). Launch with `--autoplay-policy=no-user-gesture-required`. Pause + `seek(0)` after load to match the user flow.

Measure the freeze by counting consecutive `requestVideoFrameCallback` samples where `mediaTime` doesn't advance while `!video.paused`. A clean play shows `mediaTime` tracking `currentTime`; the bug shows `mediaTime` stuck while `currentTime` runs.

(Throwaway repro scripts were under `tests/_repro_*.mjs` / `tests/_diag_*` and have been deleted — recreate from this description.)

## Next step to pin it

Dump the **actual fragmented-MP4 sample table** (per-sample DTS/PTS/size/sync-flag) **and the H.264 NAL/slice headers** of the first forward segment for **scrub-settle vs plain-seek** in the browser, and byte-diff them. The difference must be there. Angles not yet excluded:

- The tiny **2-frame seekChunk + held-anchor split** interacting with the preview's prior `firstFrameOfSegment` / held-anchor state (a held P-frame from the seekChunk emitted into the forward segment, forced to IDR on a B/P frame).
- Module-global worker state: `longGopBoundaryPending`, `scrubSeqBase`, `mpeg2EditUnitCounter`.

## Cheap mitigation (UX tradeoff) — DONE

The discrete `↑`/`↓` ±10 s keyboard skip now uses a **plain seek** (`player.seek`, proven clean) instead of the scrub-preview path. Rapid presses still coalesce onto an accumulated target (anchored to the live playhead when idle) with a 350 ms idle release, so mashing ↑↑ still reaches +20 s; only the GOP-head preview render between presses is dropped. The coalesced-preview "scrubbing feel" is kept for slider drags (`beginScrub`/`scrubTo`/`endScrub`). Sidesteps the keyboard-skip case without root-causing it.

Implemented in `demo/index.html` `skipSeconds()` (renamed state to `kbSkip*`; `endKbScrub()` now only releases the accumulator — no `endScrub`/settle). **Not** root-caused: a slider scrub-release that lands in an evicted region still hits the bug.

---

## Sibling bug — FIXED (committed, branch `fix/seek-end-of-clip-clamp`)

Originally reported together: pressing `↑` near the end showed **no picture change** and left the seek-bar thumb mid-bar. Root cause: seek targets clamped to `duration` (the END time of the last frame), which rounds to frame index `totalFrames` — **one past** the last decodable frame (`totalFrames-1`). The worker produced no frame there, so the `<video>` clamped the playhead back to the buffered end.

Fix: clamp to the last displayable frame.
- `MxfPlayer.lastFrameTime` getter; `seek()` and `initiateSeek()` clamp to it / `totalFrames-1`.
- `ScrubController.maxSeekTime`; `scrubTo()` / `endScrub()` clamp to it.
- demo keyboard skip clamps `kbScrubTarget` to `lastFrameTime`.
- Regression: `tests/scrub-end-clamp.test.ts`.

Verified: `↑` now fetches `editUnit 249` (the real last frame), paints it, and the thumb lands at the end.
