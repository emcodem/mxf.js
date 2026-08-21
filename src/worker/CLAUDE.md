# src/worker/ — pipeline, index, scrub, buffering

## MPEG-2 transcode pipeline (`demux-worker.ts`)

**Init** (`handleInit`): detect `pd.codec === 'mpeg2'` → fetch 2 frames (probe) → one-shot decode for `codedWidth/Height/chromaFormat/frameRate` → create `Mpeg2Transcoder` → encode probe frame → read `spspps` → `fragmenter.enableTranscodeMode` → `buildInitSegment(false)` (no audio — Chrome MSE rejects `sowt` in a video-only buffer) → post `manifest` + `initSegment`.

**Segment** (`handleFetchSegment`): fresh `Mpeg2Decoder` per segment → `write()`/`decode()` loop → `onFrame` → `transcoder.encodeFrame(yuv, tsUs, forceKey)` → `segDecoder.flush()` → `transcoder.flush()` → `buildTranscodedVideoSegment` → post `videoSegment`. `isFirstFrameOfSegment` ensures `forceKey=true` on the first emitted frame.

**`mpeg2EditUnitCounter`**: module-level `bigint`, resets to `BigInt(targetFrame)` on seek.

## WASM decoder plugin (`demux-worker.ts`, `wasm-transcode-pipeline.ts`)

`activePluginConfig && pd?.codec === activePluginConfig.mxfCodec` (checked before the MPEG-2/H.264
branches) hands the file to `WasmTranscodePipeline` instead — same manifest/init-segment shape,
codec-agnostic. ProRes is the first real user of this path (MPEG-2's production path is the native
JS decoder above, not this one).

**`packetMode: 'stream' | 'frame'`** (`WorkerPluginConfig.packetMode`, set from
`VideoDecoderPluginConfig.packetMode`, default `'stream'`): whether one MXF edit unit is one
complete decoder packet.
- `'stream'` (MPEG-2): FFmpeg's mpegvideo parser buffers internally and only emits a picture once
  it sees the *next* one's start code, so the probe chunks the first frame and `nudgeParser()`
  (feeds `00 00 01 b7`, the sequence-end code) forces the last buffered picture out — both at probe
  time and in `decodeSegment`'s flush branch.
- `'frame'` (ProRes — no FFmpeg bitstream parser exists for it): feed the whole edit unit as one
  packet, expect a frame back immediately. **Never call `nudgeParser()`** in this mode — a
  sequence-end code is a garbage packet to a parser-less decoder. `decodeSegment`'s flush branch
  checks `this.packetMode` and only calls `decoder.flush()`.

**`useI420`** (`WasmTranscodePipeline`): decided once in `create()` from whether the *first probe
frame* came back as `DecodedFrame.format === 'i420'` (feature-detected per decoder instance — see
`dec_get_i420` below) AND the Safari half-scale retry wasn't needed. `encodeI420Frame` doesn't
implement that retry's 2×2 RGBA-domain averaging, so the retry always uses `encodeRgbaFrame`
(content is irrelevant there — `transcoder.flush()`'s return value on the probe encode is
discarded; only getting the encoder to emit SPS/PPS matters).

## `dec_get_i420` (`wasm-ffmpeg-decoder.ts`, `ffmpeg_wasm/src/common/frame_io.c`)

Optional C export: one `sws_scale` straight to planar 4:2:0, replacing the older
`dec_get_rgba` → JS BT.601 pixel loop → I420 round-trip (2 conversions, wrong matrix for HD, the
expensive one in JS) with one correct-matrix conversion in C. Feature-detected once at
`WasmFfmpegDecoder` construction via `typeof mod._dec_get_i420 === 'function'` — checking the raw
export name, not `cwrap()`ing speculatively, so modules built before this export existed (already-
built `mpeg2-decoder`/`h264-decoder` binaries) still load and fall back to `dec_get_rgba` cleanly.

**Frames are copied, not viewed, out of wasm memory** (`.slice()`, same as the RGBA path) even
though that costs a memcpy: one `_drain()` call can return *multiple* frames (B-frame reorder
release), each reusing the same `_i420Ptr`/`_rgbaPtr` scratch buffer — a raw view would have every
frame in the batch alias the last one's pixels.

`Mpeg2Transcoder.encodeI420Frame` hands the wasm-decoder's bytes to `VideoFrame` with at most one
more copy (into `interleaveBuf`, only when `srcWidth/Height` differ from the MB-aligned coded dims
— e.g. 1080 vs 1088 — to place active rows over the pre-filled black/neutral padding; an exact-size
match skips even that, since `VideoFrame`'s constructor already copies internally).

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
