# mxf.js

A JavaScript **MXF demuxer + player** that runs entirely in the browser — no server-side transcoding, no plugins, no WASM. It reads broadcast MXF files (local `File` or remote URL), demuxes the essence in a Web Worker, remuxes (h264) or transcodes (mpeg2) it to fragmented MP4, and plays it through a native `<video>` element via Media Source Extensions (MSE). PCM audio that MSE can't handle is decoded and played through the Web Audio API.

Think of it as `hls.js`, but the source container is MXF.

**▶ Live demo: [emcodem.github.io/mxf.js/demo](https://emcodem.github.io/mxf.js/demo/index.html)** — open a local MXF with the file picker. (The demo's *Load URL* default and the latency/bandwidth simulator rely on the local dev server's `/media` route, so those only work via `npm run dev`.)

```
HTTP Range / File API ──► Web Worker ──► demux ──► remux / transcode (fMP4) ──► MSE ──► <video>
                                                                               └─ PCM ─► Web Audio
```

---

## Features

### Container / demux
- **OP1a MXF** parsing: partition packs, header metadata, primer, RIP.
- **Index modes**, auto-detected and surfaced on the manifest:
  - `cbg` — Constant Byte Group (seek by `frame × editUnitByteCount` math).
  - `vbe` — Variable Bytes per Element (per-frame index entry array).
  - `none` — no usable index (growing/live files); falls back to bounded sequential scanning.
- **In-header-partition indexes** (XAVC / AVC-Intra), understated `headerByteCount`, footer-RIP-only files — all handled by KLV-walking to the first Generic Container element rather than trusting byte-count math.
- **Range-based remote loading**: only the bytes needed for the current region are fetched (requires a byte-range-capable HTTP server — see [URL playback](#url-playback)).
- **Local file loading** via the File API.

### Video
| Codec | Path | Notes |
|-------|------|-------|
| **H.264 / AVC-Intra (XAVC)** | Remux to fMP4 | Played natively by Chrome (High 4:2:2 / profile 122 via its software decoder). SPS-derived `avc1` dimensions for interlaced 1080i MBAFF. - Firefox support missing yet (that requires WASM)|
| **MPEG-2** (D-10 / IMX, XDCAM Long-GOP) | Decode in JS → re-encode to H.264 via WebCodecs `VideoEncoder` → fMP4 | Full javascript MPEG-2 decoder (derived and extended from https://github.com/phoboslab/jsmpeg) and extended for interlaced 1080i 4:2:2 Long-GOP. I/P/B frames, open-GOP scrub handling, field-DCT, 4:2:0 and 4:2:2. **Bit-exact** with ffmpeg's `-idct simple` decoder — see [Decoder accuracy](#decoder-accuracy). |

All video flows through the single `<video>` element, so seeking and scrubbing work identically for every source.

### Audio
- **PCM** (Wave / AES3), 16/24-bit, decoded in the worker.
  - Played through **MSE** where supported, otherwise scheduled through **Web Audio** alongside the silent `<video>`.
- **Channel selection**: pick which source channels are routed to stereo output; near-instant switching on already-buffered audio.

### Seeking & scrubbing
- **Accurate seek**: decode preceding keyframe → exact target frame.
- **Keyframe seek**: decode only the GOP-head I-frame (near-instant, random-access granularity).
- **Fast-drag scrub**: single-flight, latest-wins preview pump with a per-keyframe scrub-preview cache (LRU). The playhead is gated on actual paint, so the picture keeps updating during a continuous drag instead of stalling.
- **Bounded buffering**: prefetch is capped by requested-ahead time, back buffer is evicted behind the playhead, and `QuotaExceededError` back-pressure is handled — so high-bitrate AVC-Intra (~280 Mbps) doesn't overflow the SourceBuffer or saturate the worker.

### Live edge — growing recordings

Play an MXF file that is **still being written** (a running recording) and follow its end forward, with gapless hand-off when the recorder rotates to a new file:

```ts
// 1. Anchor to the current (growing) file at the live edge
player.loadLive('/archive/ch01_2025-01-01T10:00:00.mxf');

// 2. Pre-load the next file in the background as soon as it appears
player.preloadNextUrl('/archive/ch01_2025-01-01T10:30:00.mxf');

// 3. The player drains the old file and continues on the new one gaplessly
player.on('live-end', () => player.switchLive(nextUrl));
player.on('live-switched', ({ url }) => console.log('now playing', url));

// 4. Catch-up events (speed strategy, default)
player.on('catchup', ({ active, rate, lagSeconds }) => {
  if (active) showBadge(`catching up ×${rate}…`);
  else hideBadge();
});

// 5. Hard re-anchor fallback (player fell too far behind)
player.on('catchup-jump', ({ lagSeconds }) => {
  player.reanchorLive(getNewestFileFromPlaylist());
});

// 6. Feed the player an updated lag estimate whenever your playlist refreshes
player.setLiveLag(lagSeconds);
```

Key points:
- `loadLive` ignores the index and streams forward; `duration` is not meaningful in live mode.
- `switchLive` / `preloadNextUrl` are **gapless** — the same MSE track and Web Audio context continue; there is no black frame, no decoder re-init, no A/V seam.
- `preloadNextUrl` starts background loading the next file while the current one is still playing; `live-end` just completes the switch. Use `switchLive` if you didn't preload.
- `reanchorLive` is for hard re-anchors only (lag too large to close smoothly). It does a clean cut to a new file — not gapless.

### Timecode
- **Per-frame System Item timecode** (the authoritative source TC, which can jump) and **computed package start timecodes** (Material / File / Source), surfaced through one `timecode` event and the `currentTimecode` getter.
- Locked to the frame **on screen** via `requestVideoFrameCallback`, so the displayed TC never lags the picture.
- Helpers exported from the package root: `formatTimecode`, `frameCountToTimecode`, `timecodeToFrameCount`, `decodeSmpte12mBcd`.

### Display aspect ratio
- Anamorphic content (SD `720×576`/`720×608`, XDCAM-EX `1440×1080`) is shown at its true shape via a `pasp` box in the sample entry — no CSS needed. The DAR is also surfaced on the manifest (`aspectRatio`) and the `aspectRatio` getter.

---

## Installation

```powershell
npm install mxf.js
```

Or clone and run from source:

```powershell
git clone <repo-url> mxf.js
cd mxf.js
npm install
npm run dev        # Vite dev server at http://localhost:5173
```

### Browser requirements
- **Chrome / Chromium-based browser.** The MPEG-2 path needs the WebCodecs `VideoEncoder`; native H.264 4:2:2 playback needs Chrome's proprietary-codec build. Firefox/Safari are untested and will at minimum lack the codec support required for the transcode path.
- Served over HTTP(S) (Web Workers and MSE require it — `file://` won't work).

---

## Usage

```ts
import { MxfPlayer } from 'mxf.js';

const video = document.querySelector('video');           // a real <video> element
const player = new MxfPlayer(video, {
  startBufferSeconds: 3,
  maxBufferSeconds: 8,
  seekMode: 'accurate',
});

player.on('manifest', (m) => {
  console.log(`${m.duration}s, ${m.pictureDescriptor?.codec}, index=${m.indexMode}`);
  console.log(`${m.displayWidth}×${m.displayHeight}`, m.aspectRatio); // e.g. 1024×576 {num:16,den:9}
});
player.on('timecode', ({ primary }) => {
  if (primary) tcLabel.textContent = `${primary.text} (${primary.source})`;
});
player.on('error', ({ message, fatal }) => console.error(message, fatal));

// Load a local file…
fileInput.addEventListener('change', (e) => player.loadFile(e.target.files[0]));

// …or a remote URL (range-capable server required)
player.loadUrl('https://example.com/clip.mxf');
```

### Scrubbing a timeline slider

```ts
slider.addEventListener('mousedown', () => player.beginScrub());
slider.addEventListener('input',  () => player.scrubTo(parseFloat(slider.value))); // live drag
slider.addEventListener('change', () => player.endScrub(parseFloat(slider.value))); // release
```

`scrubTo()` does **not** move the playhead — the player moves it onto each preview frame only once that frame is buffered, so the picture keeps updating. `endScrub()` settles accurately on the released position and resumes playback if it was running.

### Audio channel selection

```ts
player.on('audio-info', ({ channelCount, activeChannels }) => {
  buildChannelSelector(channelCount, activeChannels);
});
player.setAudioChannels([0, 1]);   // route source channels 1 & 2 → stereo L/R
player.setAudioChannels([]);       // mute
```

A runnable demo is in [`demo/index.html`](demo/index.html) (`npm run dev`, then open the page), or try the [hosted version on GitHub Pages](https://emcodem.github.io/mxf.js/demo/index.html).

---

## API

### `new MxfPlayer(video, config?)`

| Param | Type | Description |
|-------|------|-------------|
| `video` | `HTMLVideoElement` | The element all video renders through. |
| `config` | `MxfConfig` | Optional configuration (below). |

#### `MxfConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `startBufferSeconds` | `number` | `10` | Seconds to buffer before starting playback. |
| `maxBufferSeconds` | `number` | `30` | Maximum seconds to buffer ahead of the playhead (caps prefetch). |
| `pcmAudioMode` | `'mse' \| 'webaudio' \| 'auto'` | `'auto'` | How to play PCM audio. `'auto'` uses MSE where supported, else Web Audio. |
| `seekMode` | `'accurate' \| 'keyframe'` | `'accurate'` | Default `seek()` behaviour. `accurate` decodes keyframe→target; `keyframe` shows just the GOP-head I-frame. Scrubbing always uses keyframe internally and settles accurately on release. |
| `resumeBufferSeconds` | `number` | `0.75` | Seconds buffered ahead before (re)starting playback after a cold start, seek, or stall. The first decoded picture shows immediately (with `buffering: true`) while this fills. Smaller = snappier resume but more re-buffering on a thin/decode-bound source. |
| `debug` | `boolean` | `false` | Verbose `[mxf.js]` console logging. |
| `live` | `boolean` | `false` | Open the file as a growing live recording (`loadLive`). No seeking; playback follows the end forward and fires `live-end` when complete. |
| `liveCatchupStrategy` | `'speed' \| 'jump' \| 'off'` | `'speed'` | How to recover when the playhead falls behind the live edge. `'speed'`: nudge playback to `catchupRate` until within `catchupStopSeconds` of the edge (audio pitches up slightly). `'jump'`: hard re-anchor via `catchup-jump` event. `'off'`: never catch up. |
| `catchupRate` | `number` | `1.1` | Playback rate used by the `'speed'` strategy while catching up. Keep in `1.05–1.15` — audio is pitched up while active. |
| `catchupStartSeconds` | `number` | `5` | Engage `'speed'` catch-up when this many seconds behind the edge. Set above steady-state latency so normal play never triggers it. |
| `catchupStopSeconds` | `number` | `2` | Disengage `'speed'` catch-up once within this many seconds of the edge (the target latency — not zero, to avoid pressing the bleeding edge). |
| `catchupJumpSeconds` | `number` | `15` | Lag threshold for a hard jump — the `'jump'` strategy's only trigger, and the `'speed'` strategy's large-lag fallback. |

### Methods

| Method | Description |
|--------|-------------|
| `loadFile(file: File)` | Load a local MXF file. |
| `loadUrl(url: string)` | Load a remote MXF over HTTP byte ranges. |
| `play()` | Start playback (resumes Web Audio context on the user gesture). |
| `pause()` | Pause playback. |
| `seek(seconds: number)` | Seek to a time (clamped to duration). |
| `beginScrub()` | Enter scrub mode (pauses, forces keyframe previews). |
| `scrubTo(seconds: number)` | Report a live drag position during scrubbing. |
| `endScrub(seconds?: number)` | Leave scrub mode, settle accurately, resume playback. Defaults to current playhead. |
| `setAudioChannels(channels: number[])` | Choose 0-based source channels to mix to stereo (`[]` mutes). |
| `loadLive(url: string)` | Open a growing live recording. Player streams forward and fires `live-end` when the file completes. No seeking or scrubbing. |
| `preloadNextUrl(url: string)` | Start background-loading the next file while the current one is still playing; the gapless switch completes automatically on `live-end`. |
| `switchLive(url: string)` | Hand off to the next file gaplessly (same MSE + audio, no teardown). Call on `live-end` if you didn't call `preloadNextUrl`. |
| `reanchorLive(url: string)` | Hard re-anchor to a new file (clean cut, not gapless). Intended as the `catchup-jump` response. |
| `setLiveLag(seconds: number)` | Report the current estimated lag to the player so it can evaluate catch-up. Call whenever your playlist refreshes. |
| `audioDiag()` | Return a diagnostic snapshot: A/V offset, anomaly counts, audio coverage, scheduler gap. Useful for tuning and debugging. |
| `destroy()` | Tear down the worker, MSE, audio, and listeners. |

### Properties (getters)

| Property | Type | Description |
|----------|------|-------------|
| `currentTime` | `number` | Current playhead time (seconds). |
| `duration` | `number` | Total duration (seconds), `0` before the manifest. |
| `paused` | `boolean` | Whether playback is paused. |
| `buffering` | `boolean` | Whether playback is held/stalled waiting for data (mirrors the `buffering` event). |
| `indexMode` | `'cbg' \| 'vbe' \| 'none' \| null` | Seeking strategy of the loaded file, `null` before the manifest. |
| `videoDimensions` | `{ width, height } \| null` | Active (display) picture size, `null` before the manifest. |
| `aspectRatio` | `{ num, den } \| null` | Display aspect ratio (DAR), or `null` for square pixels / before the manifest. |
| `currentTimecode` | `TimecodeBundle \| null` | Timecode(s) for the frame on screen, `null` before playback (see the `timecode` event). |
| `audioChannels` | `number` | Total source audio channels (`0` until audio arrives). |
| `activeChannels` | `number[]` | Source channels currently routed to stereo. |

### Events

Subscribe with `player.on(event, handler)` / `.once(...)` / `.off(...)`.

| Event | Payload | When |
|-------|---------|------|
| `manifest` | `ManifestData` | Metadata parsed; safe to read duration, tracks, descriptors, `indexMode`. |
| `timeupdate` | `{ currentTime, duration }` | Playhead advanced. |
| `buffering` | `{ buffering, bufferedSeconds }` | Buffering **state** changed (emitted on change, not per tick). `buffering: true` ⇒ show a "Buffering…" indicator. |
| `timecode` | `TimecodeBundle` | The timecode of the frame on screen changed (per-rendered-frame, via `requestVideoFrameCallback`). |
| `seeking` | `{ targetTime }` | A seek started. |
| `seeked` | `{ actualTime }` | A seek completed. |
| `playing` | `void` | Playback (re)started. |
| `audio-info` | `{ channelCount, activeChannels }` | PCM channel count first known or changed — build a channel selector. |
| `pcm-audio` | `{ samples, sampleRate, channelCount, editUnit }` | Raw decoded PCM (for custom audio handling). |
| `codec-unsupported` | `{ codec, reason }` | A track's codec can't be played. |
| `error` | `{ message, fatal }` | An error occurred; `fatal` means playback can't continue. |
| `destroyed` | `void` | `destroy()` completed. |
| `live-end` | `void` | Live mode: the current file is complete. Call `switchLive(nextUrl)` (or rely on a prior `preloadNextUrl`) to continue gaplessly. |
| `live-switched` | `{ url: string }` | Live mode: gapless hand-off to the next file completed. Advance your current-file bookkeeping here. |
| `catchup` | `{ active: boolean, rate: number, lagSeconds: number }` | `'speed'` strategy: catch-up engaged (`active: true`, playback nudged to `rate`) or disengaged (`active: false`, restored to 1×). |
| `catchup-jump` | `{ lagSeconds: number }` | Player fell too far behind to close smoothly. Respond by calling `reanchorLive(newestUrl)` with the newest file from your playlist. |

### Types

```ts
import {
  MxfPlayer,
  // timecode helpers (re-exported from the package root)
  formatTimecode, frameCountToTimecode, timecodeToFrameCount, decodeSmpte12mBcd,
} from 'mxf.js';
import type {
  MxfConfig,
  ManifestData,
  MxfPlayerEvents,
  TimecodeBundle, TimecodeSource, ManifestTimecode,
  IndexMode,                       // 'cbg' | 'vbe' | 'none'
  MxfTrack, MxfPackage, MxfMetadata, MxfTimecodeTrack,
  PictureDescriptor, SoundDescriptor,
  Timecode,
} from 'mxf.js';
```

```ts
interface ManifestData {
  duration: number;                // seconds
  editRateNumerator: number;
  editRateDenominator: number;     // fps = numerator / denominator
  tracks: MxfTrack[];
  pictureDescriptor: PictureDescriptor | null;
  soundDescriptor: SoundDescriptor | null;
  displayWidth: number;            // active picture size to show (not the per-field StoredHeight),
  displayHeight: number;           //   0 when unknown
  aspectRatio: { num: number; den: number } | null;  // display aspect ratio (DAR), null = square
  indexMode: IndexMode;
  live: boolean;                   // true when opened via loadLive()
  longGop: boolean;                // true for H.264 Long-GOP (XAVC-L); B-frame reorder applied on fetch
  timecodes: ManifestTimecode[];   // computed start TCs from material/file/source packages
}

interface PictureDescriptor {
  codec: 'h264' | 'mpeg2' | 'unknown';
  width: number; height: number;
  storedWidth: number; storedHeight: number;
  frameRateNumerator: number; frameRateDenominator: number;
  aspectRatioNum: number; aspectRatioDen: number;    // DAR from AspectRatio (tag 0x320E); 0/0 if absent
  spsNALU: Uint8Array | null;
  ppsNALU: Uint8Array | null;
  pictureEssenceCodingUL: Uint8Array | null;
}

interface SoundDescriptor {
  codec: 'pcm' | 'aac' | 'unknown';
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  blockAlign: number;
}

// The timecode(s) for the frame on screen. `primary` is the highest-priority available
// (system → material → source → file); `all` lists every source with a `reliable` flag
// (computed package timecodes are unreliable in 'none' index mode).
interface TimecodeBundle {
  editUnit: number;
  primary: { source: TimecodeSource; text: string } | null;     // TimecodeSource = 'system'|'material'|'file'|'source'
  all: { source: TimecodeSource; text: string; reliable: boolean }[];
}
```

---

## URL playback

`loadUrl()` streams via HTTP byte ranges, so **the server must support `Range` requests** (`206 Partial Content`). `HttpLoader` probes with a 1-byte ranged GET at startup and rejects a `200` response (the server ignored `Range` and would stream the whole multi-GB file).

- ✅ `npx http-server --cors`, nginx, caddy, S3/CloudFront
- ❌ Python's `http.server` (no range support)

Cross-origin URLs also need standard CORS (`Access-Control-Allow-Origin`). The dev server does **not** set COEP headers (they would block cross-origin essence fetches from the worker), and nothing uses `SharedArrayBuffer`.

For local development, the Vite dev server (`npm run dev`) also serves the assets in `MXF_MEDIA_DIR` (default `C:/temp/mxf.js`) same-origin at `/media/<file>.mxf` with full `Range` support — so the demo's **Load URL** works out of the box (default `/media/vistek.mxf`) with no second server. That route also implements a network simulator driven by query params (`?latency=<ms>&rate=<bytes/sec>`, e.g. `/media/vistek.mxf?latency=50&rate=10m`), which the demo's latency/bandwidth inputs use. This is a dev-server-only convenience — it does not exist in the published package.

---

## Development

```powershell
npm run dev        # Vite dev server at http://localhost:5173 (serves demo/index.html)
npm test           # vitest unit tests
npm run test:e2e   # Puppeteer E2E (requires TEST_MXF_FILE)
npm run typecheck  # tsc --noEmit
npm run build      # production bundle into dist/
```

### E2E tests

E2E tests need a real MXF file and the **system Chrome** (the bundled Puppeteer Chromium lacks proprietary-codec support for H.264 MSE):

```powershell
$env:TEST_MXF_FILE="C:/temp/mxf.js/vistek.mxf"; npm run test:e2e
```

System Chrome is expected at `C:\Program Files\Google\Chrome\Application\chrome.exe`.

---

## Architecture

```
src/
  mxf-player.ts            Public player: MSE/buffer orchestration, seek/scrub state machines
  scrub-controller.ts      Fast-drag scrub render cycle (gated on paint)
  mse/mse-controller.ts    SourceBuffer append/remove queue, back-buffer eviction, quota back-pressure
  audio/                   PCM decode + Web Audio scheduling + channel routing
  worker/
    demux-worker.ts        Worker entry: init, fetch-segment, seek, scrub-preview commands
    mpeg2-pipeline.ts      MPEG-2 decode → encode → fragment pipeline
    scrub-segment-cache.ts LRU cache of per-keyframe scrub previews
  codec/
    mpeg2-decoder.ts       JS MPEG-2 decoder (I/P/B, 4:2:0 / 4:2:2, interlaced)
    mpeg2-transcoder.ts    WebCodecs VideoEncoder → H.264
  remuxer/                 fMP4 box construction + fragmenter
  essence/                 Essence extraction, AVC NAL tools
  parser/                  Partition / primer / metadata / descriptor / index-table parsing
  loader/                  File and HTTP (byte-range) loaders
  core/                    KLV, BER, UL, DataView helpers, constants
```

The worker owns all parsing, decoding, and remuxing; the main thread owns the `<video>` element, MSE buffers, and the Web Audio graph. They communicate over typed messages (`src/worker/worker-messages.ts`).

---

## Decoder accuracy

The JavaScript MPEG-2 decoder is **bit-exact with ffmpeg's scalar `-idct simple` decoder**: for the same essence it produces byte-for-byte identical YUV output (per-pixel max diff `0` across all 120 I/P/B test frames, on both the pure-JS and WASM-kernel paths). The IDCT is a direct port of `ff_simple_idct_int16_8bit` (row/column W-constant passes, including ffmpeg's row DC-only `<<3` shortcut and the `W4*(c0+32)` folded column rounding), and dequantization, mismatch control, and skipped-B macroblock prediction all follow the same rounding ffmpeg uses. This matters because the decoded frames are re-encoded to H.264 for playback — starting from the exact same pixels ffmpeg would produce keeps the transcode faithful to a reference decode.

Verified by `tests/xdcam-refcompare.test.ts` (run `npm run test:bitexact`), which compares every decoded plane against an ffmpeg reference dump and asserts an exact `0` difference (self-skips when the reference is absent, e.g. in CI). See [`BITEXACT.md`](BITEXACT.md) for the parity notes and the ffmpeg-internals details (DC bias, int16 wrap, mismatch toggle) the decode must match.

> Reference dump: `ffmpeg -cpuflags 0 -flags +bitexact -idct simple -i input.mxf -pix_fmt yuv422p -f rawvideo ref.yuv`

---

## Tested content

Verified against real broadcast files:
- D-10 / IMX MPEG-2 4:2:2 (all-I)
- XDCAM MPEG-2 Long-GOP (open-GOP, 1080i50 4:2:2)
- XAVC / AVC-Intra Class 100 (1080i50, H.264 High 4:2:2)
- XAVC Class 300 (UHD, High 4:2:2)
- 16/24-bit PCM audio, multi-channel

---

## License

MIT
