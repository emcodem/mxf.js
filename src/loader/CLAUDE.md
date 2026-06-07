# src/loader/ — URL playback

COEP headers removed from `vite.config.ts` (nothing uses SharedArrayBuffer). Cross-origin URLs still need CORS.

`HttpLoader` requires `206 Partial Content` — a `200` means the server ignored `Range` and is streaming the whole file; loader throws with a clear error to use a range-capable server (`npx http-server --cors`, nginx, caddy).
