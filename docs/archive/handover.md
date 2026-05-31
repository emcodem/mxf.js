# jsmxf — Handover

MXF demuxer browser plugin. hls.js-style: HTTP Range / File API → Web Worker demux → fMP4 remux → MSE `<video>`.

Stack: TypeScript · Vite · Web Worker · MSE · Transferable ArrayBuffers.

---

## What was built

Full end-to-end pipeline exists and runs:

| Layer | Files |
|---|---|
| KLV / BER / UL parsing | `src/core/` |
| Partition, Primer, Metadata, Index Table, Descriptor parsers | `src/parser/` |
| File bootstrap (header → RIP → footer → index) | `src/mxf-file.ts` |
| Essence extractor (index-based + sequential fallback) | `src/essence/essence-extractor.ts` |
| Annex B → AVCC, SPS/PPS extraction | `src/essence/avc-tools.ts` |
| fMP4 box builders (moov, moof/mdat, avcC, esds, sowt) | `src/remuxer/mp4-boxes.ts` |
| MP4 fragmenter (init segment + video/audio segments) | `src/remuxer/mp4-fragmenter.ts` |
| MSE controller (SourceBuffer queue) | `src/mse/mse-controller.ts` |
| Demux Web Worker | `src/worker/demux-worker.ts` |
| Player (worker ↔ MSE orchestration) | `src/mxf-player.ts` |
| Demo page | `demo/index.html` |

---

## Current state

- AVC-Intra (Annex B frame-wrapped) loads and plays in Chrome.
- SPS/PPS extracted from first frame's bitstream (no AVCSubDescriptor parsing needed).
- PCM audio routes through Web Audio API.
- Sequential essence extraction works (no index required).
- MPEG-2 transcode pipeline built — see status below.
- `debug: true` in the demo player emits detailed worker logs to DevTools console.

---

## MPEG-2 transcode pipeline

MPEG-2 is not supported by browser MSE. Pipeline:
**MPEG-2 decode (jsmpeg2 port) → YUV → WebCodecs VideoEncoder → H.264 AVCC → fMP4 → MSE → native `<video>`**

### Codec files

**`src/codec/mpeg2-decoder.ts`**
TypeScript port of `C:\dev\jsmpeg2_git\jsmpeg`. Public API:
- `write(ArrayBuffer)` — feed raw MPEG-2 elementary stream bytes
- `decode()` → fires `onFrame(YUVFrame)` synchronously
- `flush()` — emit any held I/P anchor
- `reset()` — clear state for seeking
`YUVFrame` exposes `width/height` (from MPEG-2 sequence header, authoritative display size) and `codedWidth/codedHeight` (MB-aligned, what the encoder uses).

**`src/codec/mpeg2-transcoder.ts`**
WebCodecs `VideoEncoder` wrapper (Chrome 94+, module workers).
- Encoder configured with `avc1.4d00XX` (Main Profile); level from macroblock count
- Output format: **`avc: { format: 'avc' }`** (AVCC chunks, no inline SPS/PPS)
- SPS/PPS extracted from **`metadata.decoderConfig.description`** on the first keyframe output — this is the AVCDecoderConfigurationRecord Chrome's encoder produced, guaranteed to match Chrome's own decoder expectations
- `parseSPSPPSFromAvcC(buf)` internal helper parses the avcC payload into SPS/PPS NALUs
- `_codecStr` from `decoderConfig.codec` is stored but **NOT used** for the MIME type — see codec string note below
- `flush()` → `Promise<TranscodedChunk[]>` — collect all encoded AVCC chunks
- 4:2:2 input is downsampled to 4:2:0 (row-average) before VideoEncoder

### Modified files (MPEG-2 related)

**`src/core/ul.ts`** — D-10 / SMPTE 386M essence element keys
D-10 files use byte 12 = `0x18` (not `0x15` GC). Added `UL_D10_VIDEO_ITEM_PREFIX` and `UL_D10_SOUND_ITEM_PREFIX`; updated `isPictureEssence()` and `isSoundEssence()`.

**`src/mxf-file.ts`** — Index table in header partition + essence start scan
- `scanBufferForIndexSegments(buf, offset)` — new helper
- `open()` now scans the already-fetched header metadata buffer for index table segments before checking the footer
- `findEssenceStart` rewritten: scans forward byte-by-byte from after the body partition pack to find the first `06 0E 2B 34` sync

**`src/essence/essence-extractor.ts`**
Sequential fetch capped at 1.5 GB to avoid V8's 2 GB ArrayBuffer limit.

**`src/worker/worker-messages.ts`**
Added to `manifest` event: `resolvedVideoCodec: string`, `resolvedVideoMode: 'mse' | 'webcodecs'`.

**`src/remuxer/mp4-fragmenter.ts`**
- `buildInitSegment(includeAudio = true)` — pass `false` for MPEG-2 (PCM uses Web Audio; sowt in moov causes Chrome MSE rejection)
- `enableTranscodeMode(sps, pps, width = 0, height = 0)` — overrides codec to `'h264'` and stores display dimensions from the MPEG-2 elementary stream. The MXF descriptor `storedWidth/storedHeight` is **unreliable** for MPEG-2 files (e.g. `1920×544` in the descriptor for a `1920×1080` programme, or completely absent). `buildInitSegment` prefers `transcodeWidth/transcodeHeight` when non-zero.
- `trex` boxes match actual tracks (not hardcoded VIDEO+AUDIO)
- `buildTranscodedVideoSegment(chunks)` — builds fMP4 from pre-encoded AVCC chunks

**`src/mse/mse-controller.ts`**
- `getMimeType('video', codec)` accepts either `'h264'` (default) or a full codec string like `'avc1.4d4c28'` (used directly)

**`src/mxf-player.ts`**
- `initSegment` handler: if MSE is already open, appends directly and calls `fetchNextChunk`; otherwise stores in `pendingInitSegment` for `onManifest` to flush
- `schedulePCMAudio`: uses `audioStartTime` as an absolute anchor (`AudioContext.currentTime - startSec` on first chunk)

---

## MPEG-2 — Current status and remaining blocker

### Codec string — IMPORTANT

`decoderConfig.codec` (e.g. `avc1.4d0028`) reports `constraints=0x00` in the profile string but the SPS in `decoderConfig.description` may have a different constraint byte (e.g. `0x4c`). If the SourceBuffer MIME type is built from `decoderConfig.codec`, Chrome's MSE rejects the init segment because the MIME string (`avc1.4d0028`) doesn't match the avcC-derived string (`avc1.4d4c28`).

**Fix (in place):** `actualCodecStr` in `demux-worker.ts` is always derived from `spspps.sps[1..3]` — the actual bytes in the avcC — never from `decoderConfig.codec`.

### SourceBuffer error still occurs in Puppeteer headless Chrome

The init segment triggers `RunSegmentParserLoop: stream parsing failed` from Chrome's `ChunkDemuxer`. The hardcoded-H.264 sanity test in `test/e2e/player.test.ts` (`Chrome MSE accepts hardcoded H.264 init segment`) also fires `sourcebuffer-error` with a hand-crafted known-good Baseline Profile init segment.

**Conclusion: Puppeteer's bundled Chrome for Testing does not support H.264 in MSE.** This is an environmental limitation of the headless test runner, NOT a bug in jsmxf code. The Chrome binary Puppeteer ships may be a Chromium build without proprietary codec support.

The SourceBuffer error in the **user's real Chrome** (reported in the original issue) may be a separate, still-open bug. With the current code state:
- Dimensions: correctly taken from MPEG-2 sequence headers (not the unreliable MXF descriptor)
- SPS/PPS: correctly taken from `decoderConfig.description` (the avcC Chrome's encoder produced)
- Codec string: correctly derived from SPS bytes (matches avcC constraint byte)
- Init segment: video-only moov (no sowt audio)

**What to check next in real Chrome (`npm run dev`):**
1. Open DevTools → `chrome://media-internals` in another tab — find the pipeline entry and check the exact error message after loading the file
2. The logged `initSeg bytes:` should be ~663. If the SourceBuffer error fires, look at the `RunSegmentParserLoop` message
3. If the error persists with the above all correct, the next hypothesis is that Chrome's MSE is strict about avcC `numSPS` field having top 3 bits set to `111` (our code uses `0xe1`) — Chrome's encoder might emit `0x01` (numSPS=1, no reserved bits). Check the raw description bytes: `console.log` the full `descBuf` as hex from inside `parseSPSPPSFromAvcC` to see what Chrome's encoder actually produces

---

## E2E testing (Puppeteer)

```
npm run test:e2e                                      # smoke only (no H.264 support needed)
TEST_MXF_FILE=C:/temp/jsmxf/vistek.mxf npm run test:e2e  # with file, VERBOSE=1 for full log
```

### Setup

| File | Purpose |
|---|---|
| `test/e2e/player.test.ts` | Puppeteer test: starts Vite on port 5199, opens demo, uploads file, checks for SourceBuffer errors |
| `vitest.e2e.config.ts` | Separate vitest config — E2E excluded from `npm test` |
| `package.json` `test:e2e` script | Runs vitest with E2E config |

### What the test does
- Starts a Vite dev server programmatically (port 5199, COOP/COEP headers stripped so CDP works)
- Launches headless Chrome via Puppeteer with `--use-gl=swiftshader --enable-features=WebCodecs`
- Enables CDP `Media` domain to capture Chrome's internal media pipeline log (exact error messages)
- Uploads the test file via `#fileInput`
- Waits for DOM `#log` to show manifest or error
- Asserts: no SourceBuffer error, no fatal errors, manifest received

### Current test results
| Test | Result | Notes |
|---|---|---|
| `demo page loads` | ✅ Pass | Vite + Puppeteer plumbing works |
| `Chrome MSE accepts hardcoded H.264 init segment` | ❌ Fail | Puppeteer Chrome has no H.264 MSE support |
| `MPEG-2 MXF: manifest received, no SourceBuffer error` | ❌ Fail | Same root cause |

To fix the Puppeteer tests: switch to `puppeteer-core` + a real Chrome installation (e.g. the user's Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`), or test VP8/AVC-Intra instead of MPEG-2 H.264 transcode.

---

## Earlier session fixes

**Bug 1 — `essenceStart` wrong when no RIP body entry**
`mxf-file.ts` `findEssenceStart()`: fallback now uses `body?.byteOffset ?? BigInt(fallback)`.

**Bug 2 — `trun` `dataOffset` 24 bytes too large**
`mp4-fragmenter.ts`: `dataOffset = (88 + samples.length * 16) + 8`.

**Bug 3 — Profile check blocking AVC-Intra 100**
Worker was blocking `profileIdc=122` (High 4:2:2 Intra). Check commented out.

---

## Known gaps / next work

**MPEG-2 SourceBuffer error in real Chrome**
Not confirmed fixed. The Puppeteer environment cannot test H.264 MSE. Must verify in a real Chrome session with `npm run dev` + the user's file.

**Puppeteer: use real Chrome for H.264 tests**
Replace `puppeteer` launch with `puppeteer-core` + `executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'` (or detect via `puppeteer.executablePath()` alternatives). Remove `--use-gl=swiftshader`. Real Chrome supports H.264 MSE.

**16-channel audio collapsed to 1 track**
`parseSoundDescriptor` picks the first descriptor (1ch). File has 8 PCM descriptors × 1ch. All 8 sound element KLVs are merged into one mono PCM chunk. Need to interleave or pick channels.

**Index table not found for some files**
For files where `header.footerPartition = 0` and no RIP, index may still be missing. `fetchIndexSegments` only scans the footer. For OP-Atom, the index may be in each body partition.

**No seeking**
Without index segments, `handleSeek` returns `nearestKeyframeEditUnit = targetFrame` with no byte-offset resolution.

**MPEG-2 B-frame boundary**
Fresh decoder per segment means B-frames at segment boundaries may corrupt (acceptable for IMX/D-10 all-I; fix needed for XDCAM HD long-GOP).

**Seeking not tested (MPEG-2)**
The `mpeg2EditUnitCounter` reset in `handleSeek` is implemented but not verified end-to-end.

---

## Running

```powershell
npm run dev        # starts Vite, opens demo/index.html at localhost:5173
npm test           # vitest unit tests (31 tests, all pass)
npm run test:e2e   # Puppeteer E2E (set TEST_MXF_FILE=... for file test)
npm run typecheck  # tsc --noEmit
```

Expert: Harald Jordan — MXF domain expert, BBC bmx project maintainer.
