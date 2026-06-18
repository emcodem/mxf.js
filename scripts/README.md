# scripts/ — developer diagnostics

Standalone Node tools for diagnosing live / growing-MXF playback. None are part of the build or
test pipeline; run them manually against a running source.

## `live-download-verify.mjs`

Downloads a growing recording the same way the player's worker does — HTTP `Range` reads against a
file that is still being written, size polled via `HEAD` — but in plain Node, with no decode/MSE.
For every rotated segment it reconstructs the file and MD5-compares it against the on-disk source,
isolating "is the byte pipeline faithful?" from decode/render concerns.

```bash
node scripts/live-download-verify.mjs                       # uses defaults below
MXF_LIVE_ONLY=1 MXF_CHUNK=16384 MXF_POLL_MS=25 node scripts/live-download-verify.mjs   # stress the frontier
```

Env knobs (all optional): `MXF_BASE` (default `http://localhost:7070`), `MXF_CH` (`1`),
`MXF_MEDIA_ROOT` (`C:/temp/recordings/media.dir`), `MXF_OUT_DIR` (`C:/temp/debuglive`),
`MXF_CHUNK` (4 MiB), `MXF_POLL_MS` (500), `MXF_STABLE` (2), `MXF_LIVE_ONLY` (`1` = follow only the
currently-growing file).

## `scan-partitions.mjs`

Scans an MXF for partition packs and prints each one's kind (HEADER/BODY/FOOTER) and open/closed
status — so you can tell a single continuous growing MXF (one header) from concatenated segments
(many headers/footers), and see body-partition spacing.

```bash
node scripts/scan-partitions.mjs <path-to.mxf>
```
