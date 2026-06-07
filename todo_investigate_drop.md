# TODO: Investigate latency-test frame drop (steady playback under 50ms RTT)

Status: **open** — deferred until after a cache clear. NOT related to the MPEG-2 chroma
decode fixes (those changed pixel values only, not decode speed / frame pacing).

## Symptom

`test/e2e/latency.test.ts` → "corporate (1ms) vs internet (50ms): … frames displayed"
fails on assertion #4 (the FRAME BAND check):

```
steady playback dropped frames under latency: low=14 high=12: expected 12 to be greater than 12.6
```

- `low.framesIn1sAfterStart`  = 14  (1ms RTT profile)
- `high.framesIn1sAfterStart` = 12  (50ms RTT profile)
- Band: `high > low * FRAME_BAND` → `12 > 14 * 0.9 (=12.6)` → **fails by 0.6 of a frame**
- This machine renders **85.7%** of the low-latency frame count; the band wants ≥ 90%.

The assertion lives at `test/e2e/latency.test.ts:320-323`.

## What is ruled out

- **Not test parallelism.** Reproduces identically when run solo AND after setting
  `fileParallelism: false` in `vitest.e2e.config.ts`. (That config change DID fix the
  separate `CONNECTION_REFUSED` / manifest-timeout contention failures — those are gone.)
- **Not the chroma decode fix.** Changes were confined to chroma pixel reconstruction
  (4:2:2 field-DCT organization, chroma quant-matrix default, chroma MV shift). Same op
  count, just different write strides → no decode-throughput impact. Frame *display* count
  under latency is about decode throughput + network pacing, not pixel correctness.
- **Deterministic, not flaky.** Produced exactly 12 across multiple runs on this machine.
  So it's a threshold-vs-machine calibration, not random noise.

## Numbers / knobs (all env-overridable, see top of `latency.test.ts`)

- `MXF_FRAME_BAND` (default **0.9**) — the failing tolerance.
- `MXF_LAT_LOW`=1, `MXF_LAT_HIGH`=50 (ms RTT for the two profiles).
- `MXF_RATE_HIGH`=0 (bytes/sec for internet profile; 0 = unlimited).
- `TEST_URL_MXF` (default `vistek.mxf`), `MXF_SERVE_DIR` (default `C:/temp/mxf.js`).
- Range server: `scripts/range-server.mjs` (deadline-based throttle).

Quick repro:
```powershell
npx vitest run --config vitest.e2e.config.ts test/e2e/latency.test.ts
# pass on this machine by loosening the band:
$env:MXF_FRAME_BAND="0.8"; npx vitest run --config vitest.e2e.config.ts test/e2e/latency.test.ts
```

## Investigation plan (after cache clear)

1. **Re-measure on a quiet machine / fresh cache.** Run latency.test solo 3-5× and record
   `low.framesIn1sAfterStart` vs `high`. If `high` climbs to ≥13 the band is fine and the
   earlier numbers were residual load; if it stays at 12, it's a real pacing gap.
2. **Confirm baseline on `main` (pre-fix).** `git stash` the decoder changes, `npm run build`,
   re-run latency. If it also reports 12/14, the drop predates this work (expected).
3. **Characterize the gap.** The test measures `framesIn1sAfterStart` — how many distinct
   `<video>` frames present in the 1s window after playback starts. Under 50ms RTT the
   cold-start ramp (CLAUDE.md "Thin-line latency": ~0.25→0.5→1→2s chunks) + speculative
   prefetch determine how fast frames arrive. Check whether the first 1s straddles the ramp
   so the 50ms profile is still filling its first/second chunk while the 1ms profile is
   already steady. If so, the metric is sampling the ramp, not steady state.
4. **Decide the fix:**
   - If it's ramp-sampling: start the 1s measurement window AFTER the ramp settles, or
     extend the window, rather than loosening the band.
   - If it's a genuine machine-speed delta: lower `MXF_FRAME_BAND` default to ~0.8 (still
     catches gross drops) and document the machine-dependence.
   - If it's a real pacing regression: dig into `mse-controller` / prefetch cap under
     latency (CLAUDE.md "Buffering / back-pressure").

## Files

- `test/e2e/latency.test.ts` (assertion @ :320, env knobs @ :38-51, scenario @ runScenario/profile)
- `scripts/range-server.mjs` (latency injection)
- `vitest.e2e.config.ts` (now `fileParallelism: false`)
