# src/worker/ — pipeline, index, scrub, buffering

## Playlist mode (seamless multi-clip, `demux-worker.ts`)

`initPlaylist` parses clip 0 fully (shared init segment + transcode pipeline) and stashes its bootstrap
as `templateBootstrap`. `registerClip{clipIndex,url}` builds a LIGHT bootstrap (`MxfFile.openLight` —
reuses the template's metadata/essence location; only re-derives length and, for VBE, the per-clip
index) and replies `clipReady{clipIndex,frameCount}`. `clips[]` holds `{loader, bootstrap}` per clip;
the fragmenter + pipeline are shared.

`fetchSegment`/`seek`/`scrubPreview` carry `clipIndex` + `frameOffset` (the clip's start on the GLOBAL
edit-unit timeline; both default 0 = single-file). Frame numbers in/out are LOCAL for essence reads +
index, GLOBAL (`local + frameOffset`, via `globalOf`) for every posted edit unit + the fragmenter
`baseMediaDecodeTime` (the `frameOffset` param on the build methods) + `pcmSamples.editUnit` + cache
keys — so clips tile on one MSE timeline. A forward fetch whose `clipIndex` changes resets the
persistent decoder (`lastFetchClipIndex`); the last segment of a clip flushes the held anchor
(`atEndOfClip`). The player clamps each fetch to one clip (boundaries are GOP boundaries). `'none'`
index clips fall back to a full `open()` (shared `sparseKf` is not clip-keyed — known limit).

## MPEG-2 transcode pipeline (`demux-worker.ts`)

**Init** (`handleInit`): detect `pd.codec === 'mpeg2'` → fetch 2 frames (probe) → one-shot decode for `codedWidth/Height/chromaFormat/frameRate` → create `Mpeg2Transcoder` → encode probe frame → read `spspps` → `fragmenter.enableTranscodeMode` → `buildInitSegment(false)` (no audio — Chrome MSE rejects `sowt` in a video-only buffer) → post `manifest` + `initSegment`.

**Segment** (`handleFetchSegment`): fresh `Mpeg2Decoder` per segment → `write()`/`decode()` loop → `onFrame` → `transcoder.encodeFrame(yuv, tsUs, forceKey)` → `segDecoder.flush()` → `transcoder.flush()` → `buildTranscodedVideoSegment` → post `videoSegment`. `isFirstFrameOfSegment` ensures `forceKey=true` on the first emitted frame.

**`mpeg2EditUnitCounter`**: module-level `bigint`, resets to `BigInt(targetFrame)` on seek.

## Index modes

`indexMode: 'cbg' | 'vbe' | 'none'`. Surfaced on `ManifestData.indexMode`.

- **`cbg`**: `editUnitByteCount > 0` in the segment. Seeks by `essenceStart + frame*editUnitByteCount`, ignoring `indexDuration` (standard CBG header segments have `indexDuration=0`). BodySID matching is permissive (`0` = match any).
- **`vbe`**: per-frame entry array.
- **`none`**: sequential scan, 4 MB windowed loop (`SEQ_WINDOW`), `SEQ_HARD_CAP=64 MB` for oversized frames. Carries incomplete trailing KLV across window boundaries.

No read-ahead overlap: `resolvedEnd` is already the next edit unit's start.

## Fast-drag scrub

Single-flight, latest-wins pump (`requestScrubPreview`/`pumpScrubPreview`). `scrubPreview` worker command folds seek + keyframe-resolve + short contiguous decode into one round-trip; `previewDone` always fires (via `finally`) to prevent deadlock. Decoupled from `pendingSeeks`.

**Render model** (`mxf-player.ts`): `scrubTo()` does NOT move the playhead. Cycle: `scrubPreview → previewDone → set currentTime to keyframe → wait 'seeked' → next`. 400 ms watchdog (`renderSeekWatchdog`) frees a stalled cycle. `ignoreNextSeeking` suppresses our own `currentTime`-set `seeking` events.

**Preview is a short contiguous run at the keyframe** — a paused `<video>` won't settle on a lone stretched I-frame over a gap. `previewDone.editUnit` carries the keyframe edit unit; the player seeks there, not to the mid-GOP dragged position. **Remaining limit**: MPEG-2 is ~5 previews/s; very fast drags outrun it. Both recover on release.

**Scrub preview cache** (`scrubSegmentCache`): LRU, max 128, keyed by keyframe edit unit. In-flight transcodes bail on generation bump (`if (gen !== seekGeneration) break`). Cleared per file load.

## Buffering / back-pressure (`mxf-player.ts`, `mse-controller.ts`)

- **Prefetch cap**: stop when `nextFetchFrame/fps − currentTime ≥ bufferAheadTarget` — bounds by requested-ahead, not buffered-ahead.
- **Cancel prefetch on scrub start**: `beginScrub` → `cancelPrefetch` → `fetchQ.supersede()`. Reactive only — buffering is never pre-emptively capped by play/pause state.
- **Back buffer eviction** (`trimBackBuffer`): removes media older than `BACK_BUFFER_SECONDS` (6 s) behind playhead. Skipped during scrub.
- **Quota back-pressure** (`handleQuota`): evict behind playhead and retry; if nothing to free, re-queue and set `bufferFull`. Cleared in `onTimeUpdate` (playhead advanced) and `initiateSeek` (not clearing it stalls post-seek/post-scrub-settle fetch).

## Buffering state + startup gate (`mxf-player.ts`)

- **`buffering` event** (`{buffering, bufferedSeconds}`): emitted only on state change.
- **One-shot startup gate** (`maybeResumePlayback`, `RESUME_BUFFER_SECONDS=0.75`, `MxfConfig.resumeBufferSeconds`): holds paused on first decoded picture until `resumeBufferSeconds` is filled, then plays once. Re-armed after seek and scrub-release. Gate disarms on the play *attempt*, not `playing` — a decode-bound source can stall before `playing` fires. Mid-playback underruns surface via native `waiting`/`playing` only.

## Thin-line latency

- **Cold-start ramp**: first fetch ramps ~0.25 s → 0.5 s → 1 s → 2 s (doubles each chunk, capped at `framesPerChunk`). `MIN_CHUNK_FRAMES=3` but `ceil(fps*0.25)≥7` in practice. Ramp resets per file in `onManifest`. An explicit seek size bypasses and doesn't consume the ramp.
- **Init probe**: reads 2 edit units for probe-decode, not 50. Falls back to 50 only for pathological interleaving.
- **Network sim**: deadline-based throttle in `vite.config.ts`/`range-server.mjs` — sleeps only when ahead of schedule by ≥4 ms (`PACE_MIN_MS`) to avoid the Windows timer floor (~15.6 ms).
- **Speculative read-ahead** (`speculativePrefetch`): kicks off next chunk's byte-read before decoding the current chunk. MPEG-2 transcode path only; skipped at EOF, for previews, and stretched fetches. Keyed by `startFrame`/`frameCount`/`gen`; mismatch → cheap miss → normal read. Aborted via `fetchQ.onSupersede`.

**Known limit**: cold-start ramp causes speculation misses for ~3 s; pipeline stabilizes after `frameCount` settles.
