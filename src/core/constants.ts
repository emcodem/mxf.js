/**
 * Tuning constants for mxf.js, collected in one place.
 *
 * These were previously scattered across mxf-file.ts, essence-extractor.ts, demux-worker.ts,
 * mse-controller.ts and mxf-player.ts as local `const`s and inline magic numbers. Centralising
 * them makes the I/O, buffering and scrub behaviour auditable from a single file. Values are
 * unchanged from their original definitions.
 *
 * NOTE: the playback-relevant knobs here (chunk duration, back-buffer, scrub lookahead) are NOT
 * yet exposed through `MxfConfig` — doing so is additive public API and intentionally left for a
 * later step. Today they are internal defaults.
 */

// ── Bootstrap / metadata read windows (mxf-file.ts) ──────────────────────────
/** Initial read to grab the header Partition Pack (its KLV length is read from this). */
export const PARTITION_PACK_READ_SIZE = 512;
/** Tail window read to locate the Random Index Pack and footer index at end-of-file.
 *  2 MB covers the RIP + footer partition pack + per-frame VBE index for clips up to ~190 000 frames
 *  (11 bytes/entry × 190 000 ≈ 2 MB), so one read usually covers both — avoiding a second seek to
 *  the end of a large file on a slow network share. */
export const TAIL_READ_SIZE = 2 * 1024 * 1024;
/** Initial read to parse the footer partition pack (so its declared indexByteCount can be honoured). */
export const FOOTER_READ_MAX = 4 * 1024 * 1024;
/** Upper bound on a footer index region read, when the partition pack declares its indexByteCount.
 *  The index is metadata sized to the content (≈11 bytes/frame for VBE), so 64 MB covers ~6M frames
 *  (~66 h @25fps) — far beyond any real programme — while still guarding a corrupt giant count. */
export const FOOTER_INDEX_MAX = 64 * 1024 * 1024;
/** Minimum header-metadata read when headerByteCount is present (encoders often understate it). */
export const HEADER_METADATA_MIN_READ = 1024 * 1024;
/** Header-metadata read when headerByteCount is absent/zero. */
export const HEADER_METADATA_FALLBACK_READ = 2 * 1024 * 1024;
/** Window scanned from a partition pack to find where the essence container actually starts. */
export const ESSENCE_SCAN_WINDOW = 1024 * 1024;
/** Upper bound on a single per-partition index-segment read in collectMultiPartitionIndex. A KLV
 *  declares its own length, but a corrupt/garbage BER length must not trigger a huge read — an index
 *  segment is ~11 bytes/frame, so 100 MB covers ~9M frames per partition, far beyond any real file
 *  while still catching corruption. */
export const INDEX_SEGMENT_MAX = 100 * 1024 * 1024;

// ── Sequential (no-index) essence reads (essence-extractor.ts) ───────────────
/** Default windowed read size when scanning essence without an index. */
export const SEQ_WINDOW = 4 * 1024 * 1024;
/** Hard cap on a single sequential read — guards against a corrupt/implausible KLV length. */
export const SEQ_HARD_CAP = 64 * 1024 * 1024;

// ── Playback buffering (mxf-player.ts, mse-controller.ts) ────────────────────
/** Target media duration per fetched chunk (frames = ceil(fps * this)).
 *  1 s (25 frames @25fps) balances startup latency against chunk overhead:
 *  each chunk decodes in ~0.8s for 1s of content (~1.25× realtime), so RESUME_BUFFER_SECONDS
 *  only needs to be ~1.5s and the startup gate clears after two ramp steps (~1.8s from file-pick).
 *  Seek abort cost is determined by the yield granularity in decodeSegment (5 frames ≈ 160ms),
 *  not the chunk size, so halving chunks does not change seek responsiveness. */
export const CHUNK_DURATION_SECONDS = 1;
/** Target media duration of the FIRST cold-start fetch, so play-to-first-frame is fast on thin
 *  lines. The full CHUNK_DURATION_SECONDS chunk (~2 s ≈ 12.5 MB for 50 Mbit XDCAM) would block
 *  first paint on ~2 s of download; the cold-start fetch ramps from this up to the full size.
 *  Kept modest so the FIRST decode (which gates first paint) stays small on a thin line, but not so
 *  tiny that the early ramp chunks are decode-bound below realtime — a decode-bound source (MPEG-2
 *  transcode ≈1.15× realtime) needs the ramp to reach a sustaining size before the resume gate
 *  releases, or playback starts on a buffer the small early chunks can't keep ahead of and re-stalls
 *  once (the residual cold-start stutter). 0.5 s balances first-paint latency against that. */
export const FIRST_CHUNK_DURATION_SECONDS = 0.5;
/** Floor on any ramped chunk, independent of frame rate. 3 is the IBBP (XDCAM HD Long-GOP) decode
 *  minimum: I + enough following coded frames to flush the held display-0 anchor out (the
 *  intervening B's need their backward P reference). For real XDCAM HD rates this floor never binds
 *  — ceil(fps*FIRST_CHUNK_DURATION_SECONDS) is ≥7 @25p / ≥13 @50i — it only guards low fps. */
export const MIN_CHUNK_FRAMES = 3;
/** Seconds of already-played media to keep behind the playhead before evicting. */
export const BACK_BUFFER_SECONDS = 6;
/** Minimum buffered-ahead seconds required before (re)starting playback after a cold start, a seek,
 *  or a stall. Small so resume stays responsive (the first picture is shown as soon as it decodes,
 *  while still "buffering"), but large enough that playback doesn't immediately re-stall and stutter
 *  on a thin/decode-bound source. Surfaced to the UI via the `buffering` event while the gate holds.
 *
 *  Sized to exceed ONE chunk's production latency. The decoder is serial (one chunk at a time), so
 *  delivery is lumpy: nothing for the chunk's decode time, then a whole CHUNK_DURATION_SECONDS lands
 *  at once. On a decode-bound source (MPEG-2 → H.264 ≈1.15× realtime) a full 50-frame chunk takes
 *  ~1.7 s to produce while delivering 2 s — so any cushion smaller than that chunk drains to empty
 *  before the next one arrives and playback re-stalls exactly once (observed at 0.75 s and 1.5 s).
 *  Requiring ≥ CHUNK_DURATION_SECONDS + 0.5 guarantees more than one chunk of cushion, so the next
 *  chunk's production gap can't empty the buffer. The first picture is still shown immediately
 *  (paused) while this fills, so the cost is a longer "buffering" before MOTION starts, not before the
 *  frame appears. Snappier start would mean smaller chunks (more network round-trips) — see
 *  CHUNK_DURATION_SECONDS. */
export const RESUME_BUFFER_SECONDS = CHUNK_DURATION_SECONDS + 0.5;

// ── Scrub preview (demux-worker.ts) ──────────────────────────────────────────
/** Max cached scrub-preview segments (LRU, keyed by GOP-head keyframe edit unit). */
export const SCRUB_CACHE_MAX = 128;
/** Contiguous lookahead decoded at a scrub-preview keyframe so a paused <video> paints — TRANSCODE
 *  path (MPEG-2 / wasm plugin). Kept short (0.2 s) because each transcoded preview frame costs
 *  ~32 ms to decode+encode; the old 0.4 s (11 frames at 25 fps) was conservative. 0.2 s (6 frames)
 *  is enough for Chrome to settle a paused seek on the HD sources this path serves, halving
 *  per-preview decode time (~220 ms → ~4.5 new-GOP previews/s vs the old ~2.4/s). MIN_LOOKAHEAD_FRAMES
 *  (= 4) is the fps-independent floor and is unchanged. */
export const SCRUB_PREVIEW_LOOKAHEAD_SECONDS = 0.2;
/** Contiguous lookahead for the REMUX path (H.264 / AVC-Intra — no decode, just repackage).
 *  Must be LONGER: a high-bitrate UHD all-intra source (e.g. AVC-Intra Class 300, 3840×2160p50)
 *  will NOT let a paused <video> paint a seek into a 0.2 s isolated range — Chrome holds at
 *  readyState HAVE_METADATA and never fires 'seeked', so scrub frames never update. Empirically
 *  ~0.2 s fails and ~1.0 s settles reliably at 4K; 1.0 s is used because remux is cheap (no decode,
 *  the per-preview cost is just bytes read + repackaged) so the extra frames don't slow the pump.
 *  For HD the same 1.0 s is small in bytes (~5 MB) and harmless. */
export const SCRUB_PREVIEW_LOOKAHEAD_SECONDS_REMUX = 1.0;
/** Floor on the lookahead frame count (independent of frame rate). */
export const SCRUB_PREVIEW_MIN_LOOKAHEAD_FRAMES = 4;
