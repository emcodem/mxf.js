# scripts/ — developer diagnostics

Standalone Node tools for diagnosing live / growing-MXF playback. None are part of the build or
test pipeline; run them manually against a running source.

## `scan-partitions.mjs`

Scans an MXF for partition packs and prints each one's kind (HEADER/BODY/FOOTER) and open/closed
status — so you can tell a single continuous growing MXF (one header) from concatenated segments
(many headers/footers), and see body-partition spacing.

```bash
node scripts/scan-partitions.mjs <path-to.mxf>
```
