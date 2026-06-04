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

// ── Sequential (no-index) essence reads (essence-extractor.ts) ───────────────
/** Default windowed read size when scanning essence without an index. */
export const SEQ_WINDOW = 4 * 1024 * 1024;
/** Hard cap on a single sequential read — guards against a corrupt/implausible KLV length. */
export const SEQ_HARD_CAP = 64 * 1024 * 1024;

// ── Playback buffering (mxf-player.ts, mse-controller.ts) ────────────────────
/** Target media duration per fetched chunk (frames = ceil(fps * this)). */
export const CHUNK_DURATION_SECONDS = 2;
/** Target media duration of the FIRST cold-start fetch, so play-to-first-frame is fast on thin
 *  lines. The full CHUNK_DURATION_SECONDS chunk (~2 s ≈ 12.5 MB for 50 Mbit XDCAM) would block
 *  first paint on ~2 s of download; the cold-start fetch ramps from this up to the full size. */
export const FIRST_CHUNK_DURATION_SECONDS = 0.25;
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
 *  on a thin/decode-bound source. Surfaced to the UI via the `buffering` event while the gate holds. */
export const RESUME_BUFFER_SECONDS = 0.75;

// ── Scrub preview (demux-worker.ts) ──────────────────────────────────────────
/** Max cached scrub-preview segments (LRU, keyed by GOP-head keyframe edit unit). */
export const SCRUB_CACHE_MAX = 128;
/** Contiguous lookahead decoded at a scrub-preview keyframe so a paused <video> paints. */
export const SCRUB_PREVIEW_LOOKAHEAD_SECONDS = 0.4;
/** Floor on the lookahead frame count (independent of frame rate). */
export const SCRUB_PREVIEW_MIN_LOOKAHEAD_FRAMES = 4;
