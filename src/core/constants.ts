/**
 * Tuning constants for jsmxf, collected in one place.
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
/** Tail window read to locate the Random Index Pack at end-of-file. */
export const TAIL_READ_SIZE = 65536;
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
/** Seconds of already-played media to keep behind the playhead before evicting. */
export const BACK_BUFFER_SECONDS = 6;

// ── Scrub preview (demux-worker.ts) ──────────────────────────────────────────
/** Max cached scrub-preview segments (LRU, keyed by GOP-head keyframe edit unit). */
export const SCRUB_CACHE_MAX = 128;
/** Contiguous lookahead decoded at a scrub-preview keyframe so a paused <video> paints. */
export const SCRUB_PREVIEW_LOOKAHEAD_SECONDS = 0.4;
/** Floor on the lookahead frame count (independent of frame rate). */
export const SCRUB_PREVIEW_MIN_LOOKAHEAD_FRAMES = 4;
