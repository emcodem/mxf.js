# src/loader/ — URL playback

COEP headers removed from `vite.config.ts` (nothing uses SharedArrayBuffer). Cross-origin URLs still need CORS.

`HttpLoader` requires `206 Partial Content` — a `200` means the server ignored `Range` and is streaming the whole file; loader throws with a clear error to use a range-capable server (`npx http-server --cors`, nginx, caddy).

## Source byte cache (`caching-loader.ts`)

`CachingLoader` wraps an inner `ILoader` with a **block-aligned LRU of raw (compressed) source bytes** so backward seeks / loops / scrub-revisits don't re-download bytes already fetched. It's distinct from the decoded fMP4 MSE holds (large, trimmed) — this caches the small compressed source. Wrapped in the worker at the `initUrl`/`initFile` handlers via `wrapWithSourceCache(inner, cacheBytes, live)`; budget comes from `MxfConfig.maxSourceCacheBytes` (default 256 MB, `0` = off). Everything funnels through `ILoader.fetchRange`, so wrapping at construction transparently covers bootstrap, all `indexMode`s (`cbg`/`vbe`/`none`), scrub, speculative prefetch, and seek.

- **Block-aligned, not request-keyed**: a fixed 1 MB grid (`SOURCE_CACHE_BLOCK_SIZE`) lets differently-aligned reads (no-index 4 MB windows start at scan-relative offsets; a no-index seek shifts that grid) reuse the same blocks. A `fetchRange` assembles cached blocks and fetches each run of missing blocks block-aligned in ONE inner read — never increasing traffic beyond rounding a genuine miss to block bounds (useful prefetch in sequential play). Requests larger than the whole budget bypass the cache.
- **VOD only — never live**: `wrapWithSourceCache` returns the inner loader unchanged when `live`. Already-written bytes are immutable so a full block stays valid, BUT a growing/preallocated recording returns complete-looking blocks ahead of the write frontier whose bytes will still change; the byte cache can't see that frontier (only the KLV walk's `06 0e 2b 34` check can, in `essence-extractor.ts`). The live-continuation loader swap (`demux-worker` `handleContinueLiveFile`) is likewise unwrapped.
- **Extension point**: to cache live backward-scrub regions, feed the parsed stable write-frontier offset into the cache and only store blocks fully below it.
