# mxf.js

MXF demuxer browser plugin. HTTP Range / File API → Web Worker → fMP4 remux → MSE `<video>`.

## Commands

```powershell
npm run dev        # Vite dev server at localhost:5173
npm test           # vitest unit tests (31 tests)
npm run test:e2e   # Puppeteer E2E — requires TEST_MXF_FILE
$env:TEST_MXF_FILE="C:/temp/mxf.js/vistek.mxf"; npm run test:e2e
npm run typecheck  # tsc --noEmit
```

## ISO 14496-12 box layout trap

`VisualSampleEntry` (`avc1`, `mp4v`, etc.) ends with `int(16) pre_defined = -1` — **2 bytes**, not 4.
`i32BE(-1)` writes `ff ff ff ff` (4 bytes) and shifts the `avcC` child box by 2, corrupting its size field so Chrome reads it as `0xffff0000` and rejects the init segment with `RunSegmentParserLoop: stream parsing failed`.
The correct encoding is `u16BE(0xffff)`. This is fixed in `src/remuxer/mp4-boxes.ts`.

## Chrome VideoEncoder SPS constraint flags

Chrome's `VideoEncoder` sets `constraint_set4_flag` and `constraint_set5_flag` (bits 3–2 of `SPS[2]`) even for Main Profile, where they mean "Progressive High Profile" and "I-only stream" — both wrong for a predictive codec stream. Chrome's MSE stream parser rejects the resulting init segment.
Fix applied in `src/codec/mpeg2-transcoder.ts`: `sps[2] = sps[2] & 0xc0` after `parseSPSPPSFromAvcC`.

## MPEG-2 decoder (`src/codec/mpeg2-decoder.ts`) — ported from jsmpeg, extended for MPEG-2

The decoder began as an MPEG-1 port. Making it decode a real **interlaced 1080i50 4:2:2 Long-GOP** stream (`vistek.mxf`, a DMX VISTEK test card) required a chain of MPEG-2-specific fixes. **I-frames now decode pixel-correct** (verified against an ffmpeg `yuv422p` reference). Bugs fixed, in the order they surfaced:

1. **`intra_vlc_format` ignored** → wrong AC VLC table. `intra_vlc_format=1` (intra blocks) must use **Table B-15** (`ff_mpeg2_vlc_table`), not the default B-14. Added `DCT_COEFF_B15` (built from `_B15_VLCS`), built at load from the FFmpeg table data via `_buildVlcTree`; selected when `intraVlcFormat && macroblockIntra`. B-15 has a distinct 4-bit EOB (`0110` → sentinel `0xFFFE`); B-14 (`DCT_COEFF_B14`, from `_B14_VLCS`) keeps the `0x0001`/extra-bit trick.
2. **VLC tree builder: missing children must be `-1`, not `0`.** `readHuffman` treats `codeTable[state]===0` as a leaf marker, so a `0` child makes an internal node look like a leaf → premature stop → bit desync. The hand-authored tables use `-1`; the builder must too.
3. **DC-size tables truncated to MPEG-1 (sizes 0–8).** MPEG-2 with `intra_dc_precision>0` uses sizes **0–11**. Rebuilt `DCT_DC_SIZE_LUMINANCE/CHROMINANCE` from FFmpeg `ff_mpeg12_vlc_dc_*` data (`_buildSimpleTree`).
4. **`dct_type` bit never read.** In a FRAME picture with `frame_pred_frame_dct==0`, every intra/pattern MB carries a 1-bit `dct_type` in `macroblock_modes` (MPEG-1 has none). Unread → **1-bit/MB desync**. Now read; for **field-DCT** luma blocks the 8 rows are de-interleaved across fields (`scan = 2·W−8`, lower blocks start +1 line). **4:2:2 chroma stays frame-organized** even in field-DCT MBs.
5. **`quant_matrix_extension` (ext id `0x03`) skipped.** The picture-layer extension loop only parsed `0x08` then skipped the rest. Now each extension is dispatched by id; `decodeQuantMatrixExtension` loads intra/non-intra/chroma matrices. (This stream sends the ext with all load-flags off, i.e. defaults — but the parse is required, and chroma matrices now have their own slot used by `decodeBlock`.)
6. **Full-block EOB.** A bitstream coding a coefficient at position 63 **still emits EOB** in MPEG-2. An earlier `while(n<64)` "no-EOB full block" hack (added while chasing a *misaligned* symptom) was wrong → reverted to `while(true)`; the `if(n>=64) break` stays as corruption guard.
7. **Dequant scale: MPEG-2 divides by 32, MPEG-1 by 16.** `level = (… ) >> (isMPEG2 ? 5 : 4)`. Using `>>4` for MPEG-2 doubles every AC coefficient → ~2× ringing/overshoot at edges (flat/DC areas stay correct, since DC is scaled separately by `<<(8−prec)`). This was the cause of the "edge blocking" once alignment was perfect.

### P/B frames (Long-GOP) — DECODED (vistek.mxf verified)
MPEG-2 P/B decode works: all 12 frames of `vistek.mxf` match the ffmpeg `frames.yuv` reference at meanY 0.04–0.08. `decodeMacroblock` reads `frame/field_motion_type`, reconstructs MVs (`readMotionVectors`/`decodeMV`), and forms inter prediction (`formInterPrediction`).

The P/B desync that blocked this for several sessions was **not** missing motion comp — it was the hand-authored jsmpeg **`MACROBLOCK_ADDRESS_INCREMENT` (Table B-1) VLC tree**, which decoded `00000`→increment 7 (an impossible B-1 prefix code). The I-frame only uses `inc=1`, so the error stayed latent until P/B used larger increments + escape, desyncing every inter slice. Fixed by rebuilding `MACROBLOCK_ADDRESS_INCREMENT` and `MACROBLOCK_TYPE_INTRA/_PREDICTIVE/_B` from canonical FFmpeg data (`libavcodec/mpeg12data.c` `ff_mpeg12_mbAddrIncrTable`; `mpeg12.c` `table_mb_ptype`/`table_mb_btype`) via `_buildLeafTree` with Kraft + round-trip self-tests.

NOTE: `vistek.mxf` turned out to use **only frame-based MC** (no dual-prime, no field MC) — earlier "dual-prime present" reports were phantoms of the desync. The decoder's `predictField`/dual-prime paths exist but are **unverified on real field-MC/dual-prime content**; a stream that actually uses them may still need work.

**Open-GOP scrub fix — suppress leading B's after a random-access `reset()`.** XDCAM long-GOP is open-GOP: a GOP's leading B-frames (coded after the I, displayed before it) reference the *previous* GOP's anchor, and B-frames emit immediately — *before* the held I-anchor. `reset()` originally kept the old reference buffers ("stale refs are harmless" — true only for closed GOPs), so after a scrub/seek into an open GOP those undecodable leading B's predicted from whatever GOP we scrubbed away from → stale macroblocks from the wrong GOP, emitted at the keyframe's own slot. (Blanking the buffers instead just turned the garbage *green* — all-zero chroma is bright green in YUV; neutral is 128.)
Fix (`reset()` + `decodePicture`/`flush`): after a reset, `suppressUntilKeyframe` discards every emitted frame until the random-access **I-frame** itself is emitted, so the keyframe — not an undecodable leading B — lands at the keyframe slot (and the dropped B's don't advance the edit-unit counter, so the I lands exactly at the resolved keyframe edit unit). This is correct for all seeks (you sought *to* the I; frames displayed before it are dropped) and needs no `closed_gop` parsing. Reference buffers are also blanked to neutral grey (Y=0, chroma=128) as defence-in-depth. **Also fixed a latent bug:** the held I-anchor was flagged `isKeyframe=false` because the flag read the *current* picture type (the next P) instead of the held frame's — now tracked via `heldAnchorIsKeyframe`. Clean stream start is unaffected (no `reset()` there, so a closed first-GOP's leading B's still emit — the yuv-debug from-start match relies on this). Regression test: `tests/xdcam-scrub-repro.test.ts` (skips without `C:/temp/mxf.js/xdcam_vistek.mxf`) asserts the first frame after a scrub-reset is the keyframe with content == a clean decode of the GOP-head.

Chroma was verified clean: `test/e2e/debug.html` reports a per-frame chroma diff (`meanC`), and all frames are rounding-level (0.06–0.14) with the I-frame lowest. The `(r18,c59):130` worst-MB in the single-frame `[diff]` is a max-single-sample metric on a leading open-GOP B-frame (half-pel rounding at the test card's center color edges) — benign, not a decode error.

### Debug tooling (keep — needed for the motion-comp work)
- `test/e2e/debug.html` + `test/e2e/yuv-debug.test.ts`: decodes N frames, renders a **montage** (`debug-montage.png`) to spot per-frame desync, and a single frame (`debug-yuv.png`). Auto-loads a reference frame from `C:/temp/mxf.js/ref.yuv` (`ffmpeg -i in.mxf -frames:v 1 -pix_fmt yuv422p ref.yuv`) and prints a **per-MB diff** vs ground truth, an offset/shift test, and a worst-MB pixel dump. `Mpeg2Decoder.debugInfo()` exposes slice/MB counts, dct_type stats, extension ids, and a `dbgLog` of slice/MB/coefficient traces. VLC/DC trees self-test at load (Kraft sum, round-trip).

## MPEG-2 transcode pipeline

**Init path** (`handleInit` in `src/worker/demux-worker.ts`):
1. Detect `pd.codec === 'mpeg2'` from MXF descriptor.
2. Fetch first video frame via `EssenceExtractor.fetchFrames(0n, 50)`.
3. Probe-decode with a one-shot `Mpeg2Decoder` to get `codedWidth/Height`, `chromaFormat`, `frameRate`.
4. Create `Mpeg2Transcoder(codedW, codedH, displayW, displayH, fps)` — wraps WebCodecs `VideoEncoder` targeting H.264 Main Profile.
5. Encode the probe frame → `transcoder.flush()` → read `spspps` (SPS/PPS from `decoderConfig.description`). Discard the encoded chunk.
6. Call `fragmenter.enableTranscodeMode(sps, pps, codedW, codedH)` — switches codec to `'h264'`, stores SPS/PPS, uses coded (MB-aligned) dims in the `avc1` box.
7. Build init segment **without audio track** (`buildInitSegment(false)`) — Chrome MSE rejects `sowt` in a video-only buffer.
8. Post `manifest` then `initSegment`.

**Segment path** (`handleFetchSegment`):
1. Fetch raw MPEG-2 ES frames from `EssenceExtractor`.
2. Create a **fresh** `Mpeg2Decoder` per segment (avoids stale reference frames on seek; fine for all-I D-10, known gap for B-frame boundary).
3. For each video frame: `write()` then loop `decode()` — the `onFrame` callback fires inside `decode()` for B-frames (immediate) and on the NEXT decode / `flush()` for I/P frames (held-anchor pattern).
4. Callback fires `transcoder.encodeFrame(yuv, tsUs, forceKey)`. `isFirstFrameOfSegment` flag ensures `forceKey=true` on the first emitted frame.
5. `segDecoder.flush()` emits the final held anchor.
6. `transcoder.flush()` returns all `TranscodedChunk[]`; edit units are assigned sequentially from `startFrame`.
7. `fragmenter.buildTranscodedVideoSegment(chunks)` → post `videoSegment`.

**Chroma handling** (`Mpeg2Decoder` → `Mpeg2Transcoder`):
- Decoder emits `YUVFrame` with `chromaFormat: 1` (4:2:0) or `2` (4:2:2).
- D-10 files are 4:2:2. Transcoder downsamples to I420 (4:2:0) by averaging each pair of chroma rows before passing to `VideoFrame`.
- DC predictor tracking in `decodeBlock`: even chroma blocks (4, 6) → `dcPredictorCb`; odd (5, 7) → `dcPredictorCr`. Swapping these causes wrong chroma DC values in every macroblock after the first in each slice.

**Timestamps / counters**:
- `mpeg2EditUnitCounter` (module-level `bigint`) starts at 0, increments per emitted frame, resets to `BigInt(targetFrame)` on seek.
- On seek: `handleSeek` sets the counter; the next `handleFetchSegment` picks it up.

## Seek modes — accurate vs keyframe (I-frame-only)

Everything still flows through the single `<video>`/MSE element; there is **no** second canvas surface.

- **`MxfConfig.seekMode: 'accurate' | 'keyframe'`** (default `'accurate'`). Accurate decodes preceding-keyframe→exact-target. Keyframe decodes *only* the GOP-head I-frame.
- **`player.beginScrub()` / `endScrub()`**: while scrubbing, every seek is forced to keyframe mode regardless of config; `endScrub()` issues one accurate seek to settle on the exact frame and resume forward playback. The demo wires the slider's live `input` → `seek()` (fast preview, thumb stays put) and `change` (release) → `endScrub()`.
- **I-frame preview mechanics**: the player posts `fetchSegment{ frameCount:1, stretchToFrames:N }`; the worker flushes the single held I-frame and `buildTranscodedVideoSegment` extends that one sample's `duration` to span the whole GOP (`N` = `gopLengthFromKeyframe`, max'd with target−keyframe so the dragged position is always covered). So the `<video>` shows the I-frame for any `currentTime` in its GOP — thumb never snaps, no seek feedback loop.
- **`previewParked`**: after a keyframe preview the decoder counter has advanced past the keyframe, so forward playback must NOT resume by fetching from there (would double-emit the I-frame with a shifted timestamp). `previewParked` blocks `fetchNextChunk`; `play()`/`endScrub()`/any new seek clears it and re-establishes a clean accurate decode. This only matters for global `seekMode:'keyframe'`; the scrub flow always settles via `endScrub()`.
- **GOP length / keyframe flag**: `gopLengthFromKeyframe` scans index flags with the *same* `(flags & 0x80) === 0` keyframe test as `resolveFrameOffset` — still the unverified convention (see memory). A wrong value only changes how far a preview holds; it cannot corrupt playback (the accurate settle re-decodes exact frames over the same range).

## Index modes + fast-drag scrub (Phase 1)

`MxfBootstrap` carries `essenceBodySID` (BodySID of the body partition holding video — only available from the body `PartitionPack`, NOT metadata) and `indexMode: 'cbg' | 'vbe' | 'none'`. The mode is surfaced through the `manifest` worker event → `ManifestData.indexMode` → `player.indexMode` getter. `IndexMode` is exported from the package root.

- **`cbg` (Constant Byte Group)**: an `IndexTableSegment` declares `editUnitByteCount > 0`. `findCbgSegment`/`resolveCbgFrameOffset` (`index-table.ts`) seek by math `essenceStart + frame*editUnitByteCount`, **ignoring `indexDuration`** — standard OP1a CBG files put a minimal header index segment that only declares the byte count (`indexDuration=0`, no entries). `resolveFrameOffset`/`resolveExactFrameOffset` take an optional `videoBodySID` and return the CBG resolution first. BodySID matching is permissive (`0` = match any).
- **`vbe`**: per-frame entry array (the original path).
- **`none`**: no usable index (growing/live). `fetchFrames` always scans sequentially in this mode.
- **No read-ahead overlap**: the index path reads `[frame N offset, frame (N+frameCount) offset − 1]` — exactly the wanted edit units. (It used to add a +512 KB pad "for trailing audio", but `resolvedEnd` is already the next edit unit's start, so the pad only re-read the next chunk's first 512 KB → every consecutive chunk overlapped by 512 KB. Removed.)
- **Bounded no-index reads**: `EssenceExtractor.fetchFramesSequential` was a single up-to-1.5 GB read; it's now a 4 MB windowed loop (`SEQ_WINDOW`, adaptive to `SEQ_HARD_CAP=64 MB` for a frame bigger than the window) that carries the incomplete trailing KLV across reads. Index + sequential paths share `emitFromBuffer` (a sync `Generator<EssenceFrame, number>` returning the stop offset; the editUnit/videoFramesSeen accounting lives in one place).
- **Fast-drag scrub** is a single-flight, latest-wins pump in `mxf-player.ts` (`requestScrubPreview`/`pumpScrubPreview`, fields `latestScrubFrame`/`previewInFlight`/`scrubSeq`), driven by the new `scrubPreview` worker command and its `previewDone` reply. It is **decoupled from `pendingSeeks`** — the old scrub path only fired a preview when `pendingSeeks` hit 0, which never happened during a continuous fast drag (the reported "only works dragging slowly" bug). `scrubPreview` folds seek+keyframe-resolve+stretched-1-frame-decode into one round-trip (half the latency of seek→seeked→fetch) and **skips audio**; `previewDone` is posted even when superseded/errored (via a `finally`) so the pump can't deadlock. The non-scrub `seekMode:'keyframe'` path (with `previewParked`) is unchanged.
- **Scrub render model — playhead gated on `seeked`, decoupled from the finger** (`mxf-player.ts`): the original demo set `video.currentTime` to the dragged (finger) position on every `input`, but the preview frame for that position isn't buffered yet, so the paused `<video>` sat in a perpetual seek and **nothing painted** ("stops playing frames once I scrub"). Rewritten: the drag reports positions via `scrubTo()` (does NOT move the playhead); a single **cycle** runs `scrubPreview → previewDone (segment appended) → set currentTime onto that frame → wait 'seeked' (actual paint) → next cycle at the freshest position`. The next playhead move waits for the previous seek to COMPLETE — re-seeking mid-seek aborts it so the frame never paints. `beginScrub()` pauses (records prior play state); `endScrub(t)` settles accurately at the released position and resumes playback. A 400 ms watchdog (`renderSeekWatchdog`) frees a cycle if `seeked` never comes (e.g. a sparse isolated preview range the paused element won't settle on). `ignoreNextSeeking` suppresses our own currentTime-set 'seeking' events.
- **Preview is a short CONTIGUOUS run at the keyframe; the player seeks to the keyframe** (`handleScrubPreview` + `onPreviewDone`): a paused `<video>` paints a seek into a contiguous multi-frame region (this is why scrubbing the already-buffered area always worked) but will NOT settle on a lone I-frame stretched over a gap — it sits at `HAVE_METADATA` and never paints, so previews only appeared on release. So the preview now decodes `1 + ~0.4 s lookahead` REAL consecutive frames starting at the GOP-head keyframe (`stretchToFrames: 0`), and the worker reports that keyframe edit unit in `previewDone.editUnit`; the player seeks the playhead THERE (into the contiguous run), not to the mid-GOP dragged target (which may lie outside the short run). Standard keyframe-granularity scrub; `endScrub` settles to the exact frame. Verified: `getVideoPlaybackQuality().totalVideoFrames` rises mid-scrub (was 0). The run is kept SHORT and constant-per-keyframe (not the whole GOP) because for MPEG-2 each preview is a real decode+encode — decoding a full GOP+lookahead per preview saturated the worker and nothing painted; XAVC remux is cheap either way. **Remaining limit:** MPEG-2 is still a per-keyframe transcode (~5 previews/s), so a very fast drag outruns it; XAVC scrubs smoothly; both recover on release.
- **Scrub preview cache** (`scrubSegmentCache` in `demux-worker.ts`): a MPEG-2 scrub preview costs a full JS MPEG-2 I-frame decode + H.264 encode per GOP head; without caching every drag position — even repeated positions within one GOP, or scrubbing back over a visited region — repays it. A preview segment is fully determined by its GOP-head keyframe (fixed baseTime + run length), so it's cached (keyed by keyframe edit unit, LRU, max 128) and re-served verbatim on revisit with no decode/encode. `handleScrubPreview` checks the cache before touching the decoder; both the MPEG-2 and H.264 (XAVC) preview paths store into it. A superseded in-flight transcode also **bails its decode loop** on a generation bump (`if (gen !== seekGeneration) break`) so a scrub doesn't wait for a whole buffer-ahead chunk to finish. Cleared per file load.

## Buffering / back-pressure (bounded prefetch + eviction)

The player must NOT prefetch the whole file — doing so saturates the transcode worker (starving scrub previews) and overflows the SourceBuffer (`QuotaExceededError`), which is exactly what happened with high-bitrate AVC-Intra (~280 Mbps) and, less severely, Long-GOP MPEG-2.
- **Cap by requested-ahead, not buffered-ahead** (`fetchNextChunk`): prefetch stops when `nextFetchFrame/fps − currentTime ≥ bufferAheadTarget`. `nextFetchFrame` is exactly how far ahead we've already asked for, so it bounds prefetch regardless of where the decoded/transcoded samples land in `video.buffered`. The old `getBufferedAhead()`-only check undercounted when the transcode timeline lagged the fetch position or the ranges were fragmented, so it never tripped → whole-file prefetch.
- **Cancel prefetch on scrub start** (`beginScrub` → `cancelPrefetch` worker command → `fetchQ.supersede()`): after a scrub release the player fills the full `maxBufferSeconds` forward buffer (useful if the user then plays). But if the user instead resumes scrubbing, that forward MPEG-2→H.264 transcode burst would keep the worker busy exactly when previews are needed (the "hangs 1–2 s before previews resume" symptom). So scrub start drops the in-flight/queued prefetch wholesale (the in-flight transcode bails on the generation bump within ~one frame), freeing the worker. This is reactive — buffering is never pre-emptively limited by play/pause state (an earlier attempt that capped the buffer while paused was wrong: it under-buffered a legitimately-paused user). The player clears `fetchPending` on `beginScrub` since the abandoned fetch won't post `segmentDone` (endScrub's seek re-arms it). NOTE: this removes prefetch *contention*; a resumed scrub into a NEW GOP still costs one fresh ~per-keyframe transcode (~700 ms for MPEG-2), the cache serves revisits instantly.
- **Back buffer eviction** (`MseController.trimBackBuffer`, called from `onTimeUpdate` when NOT scrubbing): removes played media older than `BACK_BUFFER_SECONDS` (6 s) behind the playhead. Skipped during scrub — the playhead hops to far-apart preview positions there, so trimming relative to it would evict the very preview frames being shown.
- **Quota back-pressure** (`MseController.handleQuota` → `onBufferFull`): when `appendBuffer` throws `QuotaExceededError`, it evicts behind the playhead and retries; if there's nothing behind to free (the forward buffer alone is over quota, normal for AVC-Intra), it re-queues the append and signals the player to set `bufferFull` and stop fetching until the playhead advances. `bufferFull` is cleared in `onTimeUpdate` (playhead advanced → room freed) and in `initiateSeek` (a seek targets a new region, so prior back-pressure no longer applies — not clearing it there stalls the post-seek/post-scrub-settle fetch forever).
- The `MseController` append queue is generalized to `append | remove` ops, all serialized through one `updateend` cycle per track.

## XAVC / AVC-Intra in-header-partition index + essence start

XAVC OP1a files (`xavc_p50_vistek.mxf`, `xavc_class100_50i_vistek.mxf`) put **the essence in the header partition** (`bodySID=1`) and a **CBG `IndexTableSegment` in that partition's index region** (between `headerByteCount` and the first essence KLV). They also understate `headerByteCount` (it doesn't cover all the metadata) and have **no footer index** (the footer holds only a RIP), so the old logic produced `indexMode:'none'` and a wrong `essenceStart`:
- **`MxfFile.locateEssence`** (replaced `findEssenceStart`): KLV-walks the essence-bearing partition (chosen via the RIP `bodySID>0` entry, else fallback), **collecting Index Table Segments** it passes and stopping at the **first Generic Container element** (`isGenericContainerElement`: key bytes [8..11] = `0D 01 03 01`, i.e. system/picture/sound/data/D-10). That offset is `essenceStart` (where CBG frame 0 / index streamOffset 0 is measured from); the collected segments are merged into `indexSegments` (deduped). Byte-count math is *not* trusted — walking is robust to the understated counts. This shifted vistek's `essenceStart` 524288→524800 (the body PP start → the first content-package element), which is the correct streamOffset-0 base.
- **RIP UL fix** (`UL_RANDOM_INDEX_PACK`): the constant had dropped the byte-12 `01` (`…02 01 11 01 00 00` vs the SMPTE `…02 01 01 11 01 00`), so the RIP — and thus body-partition offsets — was never found. Fixing it makes `locateEssence` pick the right partition.
- **SPS-derived avc1 dimensions** (`parseSPSCodedDimensions` in `avc-tools.ts`, used by `Mp4Fragmenter.buildInitSegment` for the native H.264 path): interlaced AVC-Intra (1080i, `frame_mbs_only_flag=0`) is one MBAFF AU per frame coded at the full **1088** height, but the MXF descriptor stores the **per-field** `StoredHeight=544`. Declaring 544 in the avc1 box while the SPS codes 1088 makes Chrome's MSE parser reject the segment → no picture. Now the coded dimensions parsed from the SPS (1920×1088) populate the avc1 box, mirroring the MPEG-2 transcode path's coded-dim handling. (Both XAVC files are H.264 High 4:2:2 / profile 122; Chrome decodes them via its software FFmpeg decoder.)

## URL playback (COEP)

The vite dev server previously set `Cross-Origin-Embedder-Policy: require-corp`, which makes the page cross-origin isolated and **blocks the worker's `fetch()` of an MXF on another origin** (e.g. `http://localhost:8000/clip.mxf`) unless that server also sends `Cross-Origin-Resource-Policy` — so URL playback "didn't work at all". Nothing uses SharedArrayBuffer, so the headers were removed (`vite.config.ts`). Cross-origin URLs still need normal CORS (`Access-Control-Allow-Origin`) on the file server. **`HttpLoader` REQUIRES byte-range support**: it probes with a 1-byte ranged GET at startup and every `fetchRange` insists on `206 Partial Content` — a `200` means the server ignored `Range` and is streaming the WHOLE file (e.g. Python's `http.server`, which has no range support), so it cancels the body and throws a clear error telling the user to use a range-capable server (`npx http-server --cors`, nginx, caddy). Without this guard a single read silently downloaded the entire multi-GB file.

## E2E test setup

Puppeteer uses the system Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` (headless).
The bundled Chromium in the `puppeteer` package lacks proprietary codec support; the system Chrome binary is required for H.264 MSE tests.
