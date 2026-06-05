# Wasm Decoder Plugin

A `videoDecoder` plugin lets you swap the built-in JS decoder for an **emscripten-compiled ffmpeg decoder**, replacing or extending codec support without changing the core library.

Primary use cases:

- **Add a codec the browser cannot play natively** — ProRes, MJPEG, DNxHD — by decoding in wasm and re-encoding to H.264 via WebCodecs.
- **Override any `pd.codec` value** including `'unknown'` (unrecognised descriptor), so a plugin can handle a codec the library doesn't identify.
- **Firefox path** — once a wasm encoder is available, the full decode+encode pipeline bypasses WebCodecs entirely.

> **Long-GOP MPEG-2 (XDCAM HD, XDCAM EX) is not supported by this path.** MXF stores MPEG-2 frames in decode order (I P B B P B B...) which is correct for the decoder. However, ffmpeg's mpeg2video reorder buffer holds B-frames internally and releases them one-at-a-time as each subsequent EU arrives, giving only ~50% of frames per segment. This causes the H.264 timeline to lag behind the EU-count timeline, breaking the player's buffer management and causing double-speed playback. The **native JS MPEG-2 decoder** avoids this entirely via its held-anchor pattern. The wasm path works correctly for **all-intra MPEG-2** (D-10/IMX) and any codec without B-frames.

---

## How it works

When the MXF descriptor's `pd.codec` matches the plugin's `mxfCodec`, the worker:

1. Loads the emscripten module via a dynamic `import()` (requires a module worker — see below).
2. Probe-decodes the first frame to learn coded dimensions.
3. Encodes the probe frame through WebCodecs `VideoEncoder` to obtain SPS/PPS.
4. Runs the persistent decode loop: wasm → RGBA frames → `VideoFrame('RGBA')` → WebCodecs encoder → H.264 AVCC → fMP4 → MSE.

For all-intra codecs (ProRes, MJPEG, D-10 MPEG-2) this is straightforward: each MXF edit unit is one complete picture, the decoder emits one frame immediately, and the pipeline runs at 1:1 EU-to-frame ratio.

For Long-GOP codecs with B-frames: the decoder's reorder buffer causes frames to be held back until forward-reference P-frames arrive, giving <1 frame per EU. See **Limitations** below.

---

## Requirements

### Module worker

The plugin is loaded with a dynamic `import()` inside the worker. The worker is already built and served as an ES module (`dist/demux-worker.js`), and `MxfPlayer` spawns it with `{ type: 'module' }`. **No extra setup needed** — this works in Chrome 80+, Firefox 114+, Safari 15+.

### Emscripten C API

Your wasm must be compiled with emscripten and export these C functions:

```c
// Open a decoder context for the named FFmpeg codec.
// Returns an opaque context pointer (non-zero on success).
void* dec_create(const char* codec_name, int width, int height);

// Push a chunk of elementary-stream bytes. The internal parser (e.g. mpegvideo)
// finds picture boundaries, so arbitrary chunk sizes are fine.
// Pass ptr=NULL, len=0 to signal end-of-stream (flush).
int   dec_send_packet(void* ctx, const uint8_t* data, int len);

// Returns 1 if a decoded frame is waiting; 0 if the decoder needs more input.
int   dec_receive_frame(void* ctx);

// Dimensions of the most-recently received frame.
int   dec_frame_width(void* ctx);
int   dec_frame_height(void* ctx);

// Write RGBA pixels for the current frame into rgbaOut (caller-allocated, w*h*4 bytes).
// Returns 0 on success.
int   dec_get_rgba(void* ctx, uint8_t* rgbaOut);

// Release the context.
void  dec_free(void* ctx);
```

This matches the API used in `C:\dev\ffmpeg_wasm\web\demos\mpeg2-decoder\demo.js`.

The emscripten build produces two files:

| File | Purpose |
|---|---|
| `mpeg2-decoder.js` | ES module factory (`export default createModule`). Import this. |
| `mpeg2-decoder.wasm` | Loaded automatically by the JS glue from the same directory. |

Both files must be served from the same origin (or with CORS headers) at the same path.

---

## Configuration

```typescript
import { MxfPlayer } from 'mxf.js';

const player = new MxfPlayer(document.querySelector('video')!, {
  plugins: {
    videoDecoder: {
      moduleUrl: '/wasm/mpeg2-decoder.js',  // URL to the emscripten .js factory
      ffmpegCodec: 'mpeg2video',            // passed to dec_create()
      // mxfCodec defaults to 'mpeg2' via the built-in map — no need to set it
    },
  },
});

player.loadFile(file);
```

### `VideoDecoderPluginConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `moduleUrl` | `string` | ✓ | URL to the emscripten-generated `.js` factory file. The `.wasm` is loaded automatically from the same directory. |
| `ffmpegCodec` | `string` | ✓ | FFmpeg codec name passed to `dec_create()`. Examples: `'mpeg2video'`, `'prores'`, `'mjpeg'`, `'dnxhd'`. |
| `mxfCodec` | `string` | — | The `pd.codec` value that activates the plugin. Defaults via the built-in map (see below). Override when the automatic mapping is wrong or the codec is unrecognised (`'unknown'`). |

### Built-in `ffmpegCodec` → `mxfCodec` map

| `ffmpegCodec` | Resolved `mxfCodec` |
|---|---|
| `mpeg2video` | `mpeg2` |
| `h264` / `libx264` | `h264` |
| anything else | same as `ffmpegCodec` |

To target a descriptor that the library classifies as `'unknown'`:

```typescript
videoDecoder: {
  moduleUrl: '/wasm/prores-decoder.js',
  ffmpegCodec: 'prores',
  mxfCodec: 'unknown',  // pd.codec for an unrecognised descriptor
}
```

---

## Building a compatible wasm

The wasm must be compiled with emscripten targeting ES module output so the worker can `import()` it. A minimal `build.ps1` / `CMakeLists.txt` pattern:

```bash
emcc \
  decoder.c \
  -o dist/my-decoder.js \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORTED_FUNCTIONS='["_dec_create","_dec_send_packet","_dec_receive_frame","_dec_frame_width","_dec_frame_height","_dec_get_rgba","_dec_free","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8"]' \
  -O2
```

Key flags:

- `MODULARIZE=1` + `EXPORT_ES6=1` — produces `export default createModule` (the factory function the worker imports).
- `EXPORTED_FUNCTIONS` — the seven `dec_*` functions plus `_malloc`/`_free` for the JS-side heap helpers.
- `EXPORTED_RUNTIME_METHODS` — `cwrap` for typed function binding; `HEAPU8` to read/write the wasm heap.

The `.wasm` file is located relative to the `.js` file using `import.meta.url` inside the emscripten glue, so serve both from the same directory.

---

## Probe and dimension discovery

The plugin probes the first MXF video frame at init time:

1. Feeds it to the decoder (`dec_send_packet`) and flushes (`dec_send_packet(ctx, NULL, 0)`).
2. Calls `dec_receive_frame` and reads `dec_frame_width` / `dec_frame_height`.
3. Resets the decoder so segment decoding starts clean at frame 0.

Coded dimensions come from the decoder. Display dimensions default to the coded dimensions; the fragmenter derives the pixel aspect ratio (`pasp` box) from the MXF descriptor's `AspectRatio` field as usual, so anamorphic content (SD 720×576 at 16:9, XDCAM-EX 1440×1080) renders at the correct shape with no extra plugin configuration.

---

## Seek and scrub

The pipeline implements the same `ITranscodePipeline` interface as the native MPEG-2 path, so all seek and scrub logic (keyframe snap, scrub preview cache, speculative adjacent-GOP pre-fill) is identical. On seek the decoder context is destroyed and recreated (`dec_free` + `dec_create`) to drop stale reference frames.

---

## Limitations

- **WebCodecs `VideoEncoder` required.** The plugin path re-encodes decoded frames to H.264 via WebCodecs. This is available in Chrome and Firefox 130+; Firefox does not yet support H.264 *encoding* in WebCodecs (only AV1/VP8/VP9), so Firefox playback of MPEG-2 via this plugin is not yet possible. A future decoder+encoder wasm (ffmpeg doing both decode and H.264 encode internally) would bypass WebCodecs entirely and enable Firefox.
- **RGBA intermediate.** The wasm outputs RGBA; the WebCodecs encoder converts it to I420 internally. There is a marginal quality cost vs a direct YUV path — in practice unnoticeable at broadcast bit depths.
- **Chunk-size granularity for yields.** The decode loop yields to the worker event loop every 5 frames (same as the native path) so seeks and scrub cancellations stay responsive.
- **One plugin slot.** Only a single `videoDecoder` plugin can be active per player instance. If you need to handle multiple unknown codecs, set `mxfCodec` to `'unknown'` and dispatch internally inside the wasm based on the codec name passed to `dec_create`.
