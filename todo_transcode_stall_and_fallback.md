# TODO: three playback issues found while decode-speed-testing the full format matrix

Status (2026-11-16): **Issue A fixed, Issue C fixed, Issue B open.** Found and reproduced during
an ad-hoc decode-speed benchmarking session (2026-08-21/22). The fixes for A and C, together with
the MSE stall recovery (`resetQueue()` in `src/mse/mse-controller.ts`, `checkStallWatchdog()` in
`src/mxf-player.ts`), were committed on branch `fix/mse-stall-recovery` on 2026-11-16 — before
that they existed only as uncommitted working-tree changes. The stall recovery is *how* two of
these three issues were caught (the watchdog logs made the failure visible instead of a silent
freeze).

**Update 2026-11-17:** the MPEG-2 half of the Issue A change (a keyframe only every
`TRANSCODE_KEYFRAME_INTERVAL_SECONDS` instead of at the start of every chunk) was **reverted** in
`3f9be75`. MSE drops appended frames until the next keyframe after any `remove()`/`abort()`/
timestamp discontinuity, so without a keyframe per chunk, playback after a seek or rewind painted
almost no frames (skip-seek-freeze E2E). The ProRes all-intra change stays.

## Context: what was being tested and with what

The user asked to (1) benchmark decode speed of synthetic XAVC-like MXF files, (2) push to
harder content (fractal detail + noise instead of flat test patterns, to stress entropy/residual
decode), (3) test longer files (~60s, not just 10-20s) and 10-bit (the realistic bit depth for
real XAVC/AVC-Intra MXF, vs. the 8-bit used in the first round), and (4) test every format
mxf.js supports, not just H.264 long-GOP.

**Tool**: `scripts/benchmark-decode.mjs` (new this session) — loads a file into the real demo
player (`demo/index.html`, built `dist/` bundle — **run `npm run build` before using it if
source changed**, see root `CLAUDE.md`) via Puppeteer, drives the same J/L fast-forward ladder
the demo UI uses, and reports realized playback speed / stalls. Usage:
```
node scripts/benchmark-decode.mjs <path-to-mxf> [maxRate|"1,2,3"]
BENCH_MAX_WAIT_MS=60000 node scripts/benchmark-decode.mjs <file> "1"   # override the wait timeout
```
It also dumps per-track `SourceBuffer.buffered` ranges and `findGapAhead()` probes on change —
useful for exactly this kind of investigation. Left in place (not reverted to a minimal version)
because it's a generically useful diagnostic, not just a one-off.

**Test files** (all in `C:\temp\mxf.js\`, not checked in — regenerate with the `ffmpeg` recipes
below if needed): the "hard" content filter chain used throughout is
`mandelbrot=size=WxH:rate=R,hue=H=2*PI*t/6:s=2,noise=alls=25:allf=t+u,format=PIXFMT` (fractal
detail + continuous hue rotation + injected noise — deliberately avoids trivial/flat test
patterns so the encoder can't skip-block its way to an easy bitstream).

| File | Format | Notes |
|---|---|---|
| `xavc_50m_gop12_bf2_1080p25_60s_10b_hard.mxf` | H.264 Long-GOP 4:2:2 **10-bit**, 1080p25, 50Mbit | ✅ clean, 1.00x |
| `xavc_50m_gop12_bf2_uhd50p_60s_10b_hard.mxf` | H.264 Long-GOP 4:2:2 10-bit, UHD50p, 50Mbit | ✅ clean, 1.00x |
| `avcintra_100m_1080p25_60s_10b_hard.mxf` | H.264 **AVC-Intra** 4:2:2 10-bit, 100Mbit (GOP=1, bf=0) | ✅ clean, 1.00x — confirmed genuinely all-intra |
| `xavc_500m_gop12_bf2_uhd50p_60s_10b_hard.mxf` | H.264 Long-GOP 4:2:2 10-bit, UHD50p, **500Mbit** | Exercises the MSE stall-recovery path (already fixed) — sometimes recovers, sometimes exhausts 4 attempts and stops cleanly (expected/acceptable for this deliberately extreme bitrate) |
| `mpeg2_longgop_50m_1080p25_60s_hard.mxf` | MPEG-2 Long-GOP 4:2:2, 50Mbit (software transcode → H.264) | Mostly clean (~0.97x) — see Issue C |
| `mpeg2_allintra_50m_pal_60s_hard.mxf` | MPEG-2 all-intra 4:2:2, PAL interlaced | Fallback file — ffmpeg's `mxf_d10` muxer would not produce byte-exact SMPTE D-10/IMX tagging after a few attempts; this is plain all-intra MPEG-2, NOT verified as real D-10/IMX. Still exercises the all-intra MPEG-2 decode path. Not yet benchmarked at all. |
| `prores_422hq_1080p25_60s_10b_hard.mxf` | ProRes 422 HQ, 10-bit (WASM decode plugin → H.264 re-encode) | ❌ Issue A |
| `prores_4444_1080p25_60s_10b_hard.mxf` | ProRes 4444, 12-bit (prores_ks stores 4444 at 12-bit regardless of requested pix_fmt — expected) | ❌ Issue A |
| `dnxhd_120m_1080p25_10s_unsupported.mxf` | DNxHD (deliberately unsupported — negative test) | ❌ Issue B |

ffmpeg recipes for all of the above are reconstructable from this file's git history / session
transcript; ask if regenerating and the exact flags matter (CBR settings, `-x264-params` set
used: `b-adapt=0:scenecut=0:nal-hrd=cbr:force-cfr=1:ref=4:mixed-refs=1:weightb=1:weightp=2:8x8dct=1:trellis=2:partitions=all:direct=auto:b-pyramid=normal`).

---

## Issue A: ProRes (and likely MPEG-2) transcode pipeline stalls, and stall-recovery can't fix it — ROOT CAUSE FOUND (2026-08-22)

**Root cause, confirmed via Chrome's CDP `Media` domain (`Media.enable` +
`playerEventsAdded`/`playerMessagesLogged`, same mechanism `test/e2e/player.test.ts` already uses —
see the new `scripts/media-diag.mjs`)**: this is a **Chrome/Windows D3D11 hardware H.264 decoder
bug**, not a bug in our own bitstream or container packaging.

Sequence observed on every hardware-decode run: our decode+encode throughput for this content is
genuinely below realtime (~68ms/frame vs the 40ms/frame budget at 25fps, ≈0.6x) — this legitimately
triggers repeated MSE buffer underflows (Chrome's own diagnostic: `kBufferingStateChanged` with
`reason: DEMUXER_UNDERFLOW`). The first two or three underflows recover cleanly on their own
(`BUFFERING_HAVE_NOTHING` → `BUFFERING_HAVE_ENOUGH`, no intervention needed) — then one of them,
seemingly at random, simply **never reports another buffering-state change again**, even though our
worker keeps decoding/encoding/appending fresh data far beyond that point in the background. No
decode error, no pipeline error — Chrome just stops updating buffering state and the video sits
frozen forever (`paused=false`, `readyState` stuck at 2, i.e. still nominally "playing").

**Confirmed via `EXTRA_CHROME_ARGS=--disable-accelerated-video-decode node scripts/media-diag.mjs
<file>`**: with hardware decode disabled (`FFmpegVideoDecoder` instead of `D3D11VideoDecoder`), the
exact same content, same pipeline, same underflow-inducing throughput deficit — but the file plays
through cleanly for its full 60s, every single underflow (dozens of them) recovering on its own. No
freeze, ever, in software decode. With hardware decode, the freeze reproduced on effectively every
run (varying only in *which* underflow it happened on and whether our own seek-recovery escaped it).

**Ruled out along the way** (see below the line for the investigation trail — kept for context):
- The re-encoded H.264 bitstream is syntactically valid: NAL-level inspection (`first_mb_in_slice=0`,
  correct I/P `slice_type`, consistent `pps_id`) shows a completely normal IDR+P+P GOP. Not a
  bad-bitstream bug.
- The container/fMP4 packaging (`buildTranscodedVideoSegment`) is straightforward and unremarkable.
- The stall-watchdog's own recovery action (`initiateSeek` — pause + re-splice at the same position)
  is NOT the cause of the permanent freeze: disabling the recovery action entirely (keeping only
  detection/logging) still produces the same permanent freeze at the same kind of position, proving
  the underlying pipeline was already stuck before our recovery ever touched it.
- A larger post-seek/recovery chunk (see the real fix landed in `src/mxf-player.ts`'s `'seeked'`
  handler, `isTranscode` floor) reduces how often the wedge is hit (it eliminates the previously-
  deterministic "identical 3-frame chunk fails every single retry" shape) but does NOT eliminate it —
  confirmed by a fresh run permanently freezing at the same early position even with a full-size
  recovery chunk. This is consistent with a genuinely racy/probabilistic hardware-decoder bug that a
  bigger chunk only makes less likely to trigger (fewer splices = fewer chances), not a deterministic
  content or chunk-size bug.

**Two independent, additive angles for an actual fix** (neither alone is complete):
1. **Reduce how often real underflows happen at all** — i.e. the ProRes/MPEG-2 WASM transcode
   throughput deficit (~0.6x realtime) is the thing repeatedly triggering the underlying HW-decoder
   exposure. Faster decode/encode (see the fixed WASM heap-fragmentation leak below, and any future
   throughput work) directly reduces how often this bug gets a chance to fire.
2. **Make recovery robust to a decoder that's already unrecoverable via in-place splicing.** Since
   there is no web-exposed way to force software `<video>` decode from JS, and the browser bug means
   `SourceBuffer.remove()`/`appendBuffer()` in-place recovery sometimes just can't unstick the
   decoder, the stall-watchdog's escalation path likely needs a harder tier once soft (seek-in-place)
   recovery fails a time or two: tear down and recreate the `MediaSource`/`SourceBuffer`s entirely
   (`MseController.destroy()` + `open()` + re-append init segment + re-seek) rather than only ever
   splicing in place. A fresh `MediaSource` forces Chrome to spin up a brand-new decoder instance,
   which should not inherit whatever internal state the D3D11 decoder got stuck in. **Not yet
   implemented** — needs design/testing.

**Also worth fixing regardless of the above**: once `checkStallWatchdog`'s 4 attempts are exhausted,
`this.video.paused` is `false` (a `.play()` "succeeded" even though nothing is advancing), so no
further code path ever re-attempts recovery or even keeps `fetchNextChunk()` running — the app is
silently frozen forever unless the caller happens to handle the emitted `'error'` event. Worth an
explicit user-visible failure state / a harder final fallback instead of silent permanent freeze.

**Update (2026-08-22, later same day) — four more "are WE doing this wrong" hypotheses tested and
falsified**, in response to reasonable pushback against resting on "browser bug" too early:

1. **`MseController.resetQueue()` never called `SourceBuffer.abort()`** on a still-`updating`
   real SourceBuffer before superseding it — a genuine, independent correctness bug (the MSE spec's
   own mechanism for "cancel what's in flight, I'm about to replace it" is `abort()`, and we were
   only resetting our own JS-side bookkeeping, leaving a stale in-flight append/remove to complete
   uncontrolled). **Fixed** (`src/mse/mse-controller.ts`) — real improvement, kept. Did NOT fix the
   freeze: confirmed via CDP log that the 3rd underflow already fails to recover *before* our
   watchdog (and thus this code) ever runs.
2. **Every ~1s chunk boundary forced a fresh IDR keyframe**, regardless of whether a real
   seek/discontinuity had occurred — an artifact of `firstFrameOfSegment`/`decodeSegment()` being
   reset unconditionally on every fetched chunk, even though the transcoder is one *persistent*
   VideoEncoder session for the whole file that could safely continue the same P-frame chain across
   ordinary chunk boundaries. This made the H.264 stream far more IDR-heavy (every ~1s, each IDR
   several times the size of a P-frame) than any normal encode, and IS a genuinely unusual stream
   shape for a hardware decoder to consume. **Fixed properly** (not simply removed — an in-buffer
   backward seek that bypasses `reset()` still needs a nearby random-access point after
   `BACK_BUFFER_SECONDS` eviction, so a periodic keyframe was kept, just at a sane
   `TRANSCODE_KEYFRAME_INTERVAL_SECONDS=4` cadence instead of every chunk) in both
   `src/worker/wasm-transcode-pipeline.ts` and `src/worker/mpeg2-pipeline.ts`, with the new constant
   in `src/core/constants.ts`. Real improvement (less encode work, less data), kept. Did NOT fix the
   freeze: identical failure at nearly the same wall-clock timing with this fix active.
3. **Our stall-recovery never actually reassigns `video.currentTime`** — `initiateSeek()` only
   manipulates the SourceBuffer (evict + re-append) while leaving the playhead value untouched, so
   Chrome's own native seek algorithm (which properly resets the render/decode pipeline) never runs.
   Tested forcing a real `currentTime` reassignment before the SourceBuffer manipulation — did NOT
   fix the freeze either (reverted; risks recursive re-seeking through `onVideoSeeking()` if kept).
4. **Puppeteer window-focus / background-tab GPU throttling** — a `headless:false` puppeteer window
   isn't necessarily the OS-focused foreground window, and Chrome is known to throttle/suspend
   GPU-accelerated video decode for backgrounded windows, which could look exactly like a decoder
   wedge but be a test-harness artifact rather than a real player bug. Tested `page.bringToFront()` +
   `window.focus()` + `--disable-background-timer-throttling --disable-renderer-backgrounding
   --disable-backgrounding-occluded-windows` — did NOT fix the freeze either (kept `focusPage()` in
   `scripts/media-diag.mjs` since it's a correct hygiene practice for this class of diagnostic
   regardless).

**Corroborating evidence this is genuinely external**: couldn't find an exact matching Chromium
tracker bug (issues.chromium.org requires login, inaccessible to fetch), but "disable hardware
acceleration" turns up repeatedly as a standard, widely-recommended community fix for Chrome video
stutter/freeze/buffering complaints across many unrelated sites and players — i.e. this is a known
*category* of Chrome-on-Windows GPU/driver-dependent hardware video decode reliability issue, not
something novel to this codebase.

**RESOLVED (2026-08-23) — encode ProRes as all-intra H.264, no P-frames at all.**

The user pushed back on stopping at "browser bug" and asked the right question: ProRes is *itself*
an all-intra codec — every source frame is already independently decodable, with zero inter-frame
prediction in its own bitstream. Introducing an H.264 P-frame reference chain in the re-encode was
never a technical requirement for this pipeline, only a bitrate optimization. And the watchdog's own
diagnosis text ("likely a decode-dependency break behind the playhead") describes exactly the failure
mode a broken P-frame reference chain would produce.

**Fix**: `WasmTranscodePipeline.encodeDecodedFrame` (`src/worker/wasm-transcode-pipeline.ts`) now
always passes `forceKeyframe=true` — every emitted frame is an IDR. No P-frames, no reference chain,
nothing that can be "broken" by an underflow. This removed the now-dead periodic-keyframe machinery
(`needsKeyframe`/`lastKeyframeEU`/`keyframeIntervalFrames`/`TRANSCODE_KEYFRAME_INTERVAL_SECONDS`)
from this pipeline entirely, since forcing a keyframe every chunk is moot when every frame already is
one.

**Verified**: same repro (`prores_422hq_1080p25_60s_10b_hard.mxf`, real D3D11 hardware decode, no
`--disable-accelerated-video-decode`) — previously wedged permanently within the first ~10s on
effectively every run; with all-intra output, ran the full file with dozens of `DEMUXER_UNDERFLOW ↔
BUFFERING_HAVE_ENOUGH` cycles (matching the earlier software-decode success case) and never froze
once, across two separate confirmation runs (including after the final code cleanup). Decode+prep
timing unaffected (~66-69ms/frame either way — the H.264 encode side was never the bottleneck);
segment byte sizes increased roughly 1.5-2x as expected (no motion-compensated prediction to exploit
temporal pixel redundancy the source's own encode didn't use) — a real, accepted bandwidth cost for
eliminating a hard freeze.

**Scope**: applied only to `WasmTranscodePipeline` (currently ProRes-only). Deliberately NOT applied
to `Mpeg2Pipeline`: MPEG-2 Long-GOP source genuinely has inter-frame structure worth preserving in
the re-encode (unlike ProRes), so forcing all-intra there would be a much bigger, less-justified
bitrate/throughput cost — `Mpeg2Pipeline` keeps the periodic `TRANSCODE_KEYFRAME_INTERVAL_SECONDS=4`
keyframe fix from earlier in this investigation instead. **Open question for later**: MPEG-2
all-intra sources (D-10/IMX) also go through `Mpeg2Pipeline` and — like ProRes — have no inter-frame
prediction in their own bitstream, so the same all-intra-output argument would apply to them too.
Not tested this session (D-10/IMX didn't reproduce the freeze in the original format survey); worth
revisiting if it ever does.

Issue A is now considered fixed for ProRes. The earlier "reduce underflow frequency via throughput
work" and "graceful degradation on unrecovered stall" angles are no longer required to fix THIS
symptom, but remain worthwhile follow-ups in their own right (throughput still sits at ~0.6x
realtime for 1080p25 10-bit ProRes, and the stall-watchdog's silent-permanent-freeze-on-exhaustion
behavior is still a latent gap for whatever future case does exceed its 4 recovery attempts).

**Fixed along the way** (real, tested, independent improvements — kept regardless of the above):
- **WASM heap fragmentation leak** (`src/codec/wasm-ffmpeg-decoder.ts`): `decode()` did a fresh
  `_malloc`/`_free` of a differently-sized input-packet buffer on every call (ProRes: one call per
  edit unit, every one a different byte length) — classic malloc/free-churn heap fragmentation,
  manifesting as decode+prep cost climbing steadily over a session (68ms/f → 75ms/f observed over
  just ~6s of content). Fixed with the same grow-only reuse pattern already used for the
  `_rgbaPtr`/`_i420Ptr` output buffers. Verified: decode time now stays flat (~66-69ms/f) over a full
  run instead of climbing.
- **Post-seek chunk floor for transcode paths** (`src/mxf-player.ts`, `'seeked'` case): the accurate-
  seek chunk-size formula (`seekTargetFrame - keyframe + 3`) collapses to exactly 3 frames whenever a
  seek retargets its own keyframe exactly — which a same-position stall-recovery seek always does for
  an all-intra source. A 3-frame post-seek chunk made the underflow-recovery-wedge bug *deterministic*
  (identical failure on every retry). Floored to `framesPerChunk` whenever the source codec differs
  from the delivered codec (`isTranscode`), matching the floor `indexMode === 'none'` already had for
  the same reason. Doesn't eliminate the HW-decoder bug (see above) but removes the guaranteed-to-fail
  shape and reduces exposure.

**Diagnostic tooling added**: `scripts/media-diag.mjs` — like `scripts/benchmark-decode.mjs` but wires
up Chrome's CDP `Media` domain to capture the browser's own internal pipeline diagnostics
(`Media.enable`, `playerMessagesLogged`/`playerEventsAdded`/`playerErrorsRaised`). Accepts
`EXTRA_CHROME_ARGS` env var to pass extra Chrome launch flags (used here for
`--disable-accelerated-video-decode`). Kept as a generically useful tool for this class of "is this
actually our bug or the browser's" investigation.

---

### Original investigation trail (superseded by the root-cause finding above; kept for history)

**Reproduction**: `node scripts/benchmark-decode.mjs C:\temp\mxf.js\prores_422hq_1080p25_60s_10b_hard.mxf "1"` (also reproduces on the 4444 file, at a different position — cur=7.34s instead of 3.34s in one run, cur=6.34s in another. Not a fixed frame number, but always the same *shape* of failure).

**Symptom**: normal playback proceeds fine for several seconds (transcoding at a fairly consistent ~60ms/frame per the `[transcode]` debug logs — see below), then `currentTime` freezes. The MSE stall-watchdog (added this session) correctly detects it and fires up to its 4 bounded recovery attempts, then correctly stops (no crash, no infinite loop — the watchdog itself is working as designed). But recovery never actually succeeds for this file.

**Why this is NOT a buffering/quota problem** (i.e. not the same root cause as the MSE fix already
landed): the debug log around a recovery attempt shows the buffer gate correctly detecting
enough data and flipping to PLAY, *with real margin*:
```
[mxf.js] gate cur=6.34 v=2.10 a=2.10 target=1.50 ... reqAhead=3.10 stuck=false → PLAY vbuf=[0.00-8.44] abuf=3:[6.32-6.44][6.44-7.44][7.44-8.44]
[mxf.js] waiting cur=6.34 gating=false pending=0 vbuf=[0.00-8.44]
```
`vbuf=[0.00-8.44]` while `cur=6.34` is over 2 seconds of buffered margin — yet a native `'waiting'`
fires immediately after `PLAY`. The browser's H.264 decoder (consuming the *re-encoded* stream
from the WebCodecs `VideoEncoder`, not the original ProRes bytes) is stuck on something at this
exact point, not starved of data.

**Working hypothesis**: the recovery seek's first re-fetch is deliberately tiny —
`MIN_CHUNK_FRAMES = 3` (`src/core/constants.ts`) is the cold-start-ramp floor used after any
seek (`nextRampChunk()` in `src/mxf-player.ts`). The transcode debug log confirms this exact
shape on every one of the 4 retries:
```
[transcode] startFrame=158: 3 ES frames → 3 frames | decode+prep 183 ms (61.1 ms/f) | encode drain 6 ms (2.0 ms/f) | total 189 ms
[worker] videoSegment 92436 bytes, 3 chunks, first chunk keyframe: true first chunk editUnit: 158
```
— identical `startFrame=158`, identical 3-frame count, identical output byte count (92436,
92434, 92434 — near-identical, consistent with a deterministic re-encode of the same 3 source
frames) on attempts 1, 2, and 3. A WebCodecs `VideoEncoder` fed only 3 frames per "flush" cycle
may not be producing a fully valid/self-contained GOP in its H.264 output (e.g. an encoder
implementation that needs more lookahead/frames before it can close a GOP cleanly, or a
keyframe-interval mismatch) — that would explain a *decode-side* stall regardless of how much
buffer surrounds it, and would explain why every recovery attempt (which all land on the same
tiny 3-frame chunk, since `initiateSeek()` re-seeks to the *same* stuck position) fails
identically instead of the failure varying between deterministic retries the way a timing race
would.

**Not yet done**: confirming this hypothesis (e.g. by dumping/inspecting the actual re-encoded
H.264 bytes from that 3-frame chunk, or by testing whether the stall reproduces if
`MIN_CHUNK_FRAMES` / the ramp is bypassed for the recovery-seek case specifically), and checking
whether MPEG-2 transcode (which shares this same WebCodecs re-encode path — see
`src/codec/mpeg2-transcoder.ts`) has the same latent issue (Issue C below may be a milder version
of this exact bug, triggering less often because MPEG-2's own decode is the bottleneck rather
than hitting the stall-and-recover path as often).

**Files**: `src/codec/mpeg2-transcoder.ts` (the WebCodecs `VideoEncoder` usage — ProRes plugin
almost certainly shares this or a near-identical re-encode path, find it via the `plugins`
config / `codecUnsupported`-adjacent wiring in `src/worker/demux-worker.ts`), `src/core/constants.ts`
(`MIN_CHUNK_FRAMES`), `src/mxf-player.ts` (`nextRampChunk()`, `initiateSeek()`).

---

## Issue B: DNxHD (and presumably any genuinely unsupported codec) doesn't actually fall back to audio-only

**Reproduction**: load `dnxhd_120m_1080p25_10s_unsupported.mxf` (DNxHD has no UL table entry
anywhere in this codebase — confirmed via `src/parser/descriptor.ts identifyVideoCodec` and
`src/core/ul.ts`, so this is a clean, deliberate negative test, not a parsing bug).

**Symptom**: the manifest parses correctly and the codec is correctly identified as unsupported:
```
Codec unsupported: unknown — No plugin configured for codec 'unknown' (configured plugin(s) decode: prores)
Audio: 2 channel(s); playing 1, 2
Manifest loaded: 10.00s, 6 tracks
```
— the log even claims audio is playing. But independently verified via direct `<video>` element
inspection after an 8-second wait:
```json
{"readyState":0,"paused":true,"currentTime":0,"error":null}
```
`readyState=0` is `HAVE_NOTHING` — nothing is happening at all, not video, not audio. The
"Audio: ... playing" log line is misleading (logged unconditionally on manifest parse, not
gated on audio actually starting) or the audio-only fallback path has a bug that stops it before
first sample.

**Not yet done**: tracing why `codecUnsupported` doesn't actually engage the audio-only path —
check whether the fallback logic gates on some video-track state that never gets satisfied when
video is entirely absent from the pipeline (e.g. an MSE/gate check that waits for a video
SourceBuffer to have data it will now never receive), similar in shape to the original MSE
stall-recovery bug but for a different reason (deliberately-absent video, not corrupted data).

**Files**: `src/worker/demux-worker.ts` (`codecUnsupported` emission, ~line 733-741 per the
format survey done this session), `src/mxf-player.ts` (wherever `codec-unsupported` is handled —
`this.emit('codec-unsupported', ...)` — and whatever gates the resume/buffer logic that should
still fire for audio-only playback).

---

## Issue C: MPEG-2 Long-GOP — full pipeline reset at EOF — FIXED (2026-08-22)

**Root cause found and fixed.** Not codec-specific and not localized to `endOfStream()`/
`mpeg2-transcoder.ts` as originally suspected — it was a `video.play()`-at-end-of-media bug in
`maybeResumePlayback()` (`src/mxf-player.ts`).

**What was happening**: `maybeResumePlayback()` is called from several places (`'appended'`,
`'canplay'`, the stall handler) any time the element is paused and `playIntent` is true, and its
gate logic treats `fetchedToEof` as an unconditional green light to call `video.play()` — with no
check for whether the element had already legitimately finished. When one of those triggers fired
at the exact moment the video reached its natural end (`currentTime === duration`, `paused` set by
the browser itself after `'ended'`), the gate logged `eof=true ... → PLAY` and called
`this.video.play()`. Per the HTML spec, calling `.play()` while the current playback position
already equals the effective end of the media first performs an implicit seek to the earliest
possible position — so `currentTime` snapped to 0, firing a genuine native `'seeking'` event.
`onVideoSeeking()` had no way to know this seek wasn't a real user action: 0 isn't inside the
tail-only buffered range (`[54.48-60.00]`), so `isSeekServedByBuffer` returned false and it routed
into a real `initiateSeek(0, ...)` — `clearForward(0)` wiped the entire (finished, correct) buffer
and the worker was told to re-seek to frame 0. Confirmed via the debug log sequence:
```
gate cur=60.00 v=0.00 a=0.00 target=0.00 eof=true edge=false pending=0 reqAhead=0.52 stuck=true → PLAY vbuf=[54.48-60.00] ...
waiting cur=0.00 gating=true pending=1 vbuf=[54.48-60.00]   ← pending=1: initiateSeek(0) already ran
```
100% reproducible once found (2/2 runs of `node scripts/benchmark-decode.mjs
C:\temp\mxf.js\mpeg2_longgop_50m_1080p25_60s_hard.mxf "1"` on the un-fixed build) — the earlier
"rare, 2 of 7+ runs" characterization was really about how often some trigger happens to land
paused-at-exact-duration at all, not about the reset itself being nondeterministic. Not seen on
the native H.264 remux files tested extensively this session only because MPEG-2 transcode decodes
well ahead of realtime, making an `'appended'`/`'canplay'` callback land in that exact paused-at-
end window far more likely — the bug itself is generic to `maybeResumePlayback()`, not the
transcode pipeline.

**Fix**: `maybeResumePlayback()` now returns immediately if `this.video.ended` — nothing to
resume once the element has genuinely finished. Also hardened `checkStallWatchdog()` with the same
`video.ended` guard: it would otherwise have eventually misidentified natural end-of-file (currentTime
legitimately no longer advancing) as a stall and issued its own bogus `initiateSeek(cur, ...)`
recovery — same wrong destination, different call site. Verified fixed: 2 clean full-file runs
post-fix (`ended=true`, `realized_speed≈1.00x`, final buffered range `[54.48-60.00]`, no reset), vs.
100% reset-to-0 on the un-fixed build. `npm test` still green (192 passed).

**Files changed**: `src/mxf-player.ts` (`maybeResumePlayback()`, `checkStallWatchdog()`).
