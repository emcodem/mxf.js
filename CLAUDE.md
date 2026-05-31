# jsmxf

MXF demuxer browser plugin. HTTP Range / File API → Web Worker → fMP4 remux → MSE `<video>`.

## Commands

```powershell
npm run dev        # Vite dev server at localhost:5173
npm test           # vitest unit tests (31 tests)
npm run test:e2e   # Puppeteer E2E — requires TEST_MXF_FILE
$env:TEST_MXF_FILE="C:/temptemp/vistek.mxf"; npm run test:e2e
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

1. **`intra_vlc_format` ignored** → wrong AC VLC table. `intra_vlc_format=1` (intra blocks) must use **Table B-15** (`ff_mpeg2_vlc_table`), not the default B-14. Added `DCT_COEFF_1`, built at load from the FFmpeg table data via `_buildVlcTree`; selected when `intraVlcFormat && macroblockIntra`. B-15 has a distinct 4-bit EOB (`0110` → sentinel `0xFFFE`); B-14 keeps the `0x0001`/extra-bit trick.
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

Chroma was verified clean: `demo/debug.html` reports a per-frame chroma diff (`meanC`), and all frames are rounding-level (0.06–0.14) with the I-frame lowest. The `(r18,c59):130` worst-MB in the single-frame `[diff]` is a max-single-sample metric on a leading open-GOP B-frame (half-pel rounding at the test card's center color edges) — benign, not a decode error.

### Debug tooling (keep — needed for the motion-comp work)
- `demo/debug.html` + `test/e2e/yuv-debug.test.ts`: decodes N frames, renders a **montage** (`debug-montage.png`) to spot per-frame desync, and a single frame (`debug-yuv.png`). Auto-loads a reference frame from `C:/temptemp/ref.yuv` (`ffmpeg -i in.mxf -frames:v 1 -pix_fmt yuv422p ref.yuv`) and prints a **per-MB diff** vs ground truth, an offset/shift test, and a worst-MB pixel dump. `Mpeg2Decoder.debugInfo()` exposes slice/MB counts, dct_type stats, extension ids, and a `dbgLog` of slice/MB/coefficient traces. VLC/DC trees self-test at load (Kraft sum, round-trip).

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

## E2E test setup

Puppeteer uses the system Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` (headless).
The bundled Chromium in the `puppeteer` package lacks proprietary codec support; the system Chrome binary is required for H.264 MSE tests.
