# src/remuxer/ — MP4 box traps

## ISO 14496-12 box layout trap (`mp4-boxes.ts`)

`VisualSampleEntry` (`avc1`, `mp4v`, etc.) ends with `int(16) pre_defined = -1` — **2 bytes**, not 4. Use `u16BE(0xffff)`, not `i32BE(-1)` — the latter shifts `avcC` by 2, corrupting its size field.

## Anamorphic display aspect ratio (`mp4-fragmenter.ts`)

SD `720×576`/`720×608` and XDCAM-EX `1440×1080` have non-square pixels. The MXF `AspectRatio` (local tag `0x320E`, a `Rational`) carries the DAR, parsed into `PictureDescriptor.aspectRatioNum/Den`. Applied via a `pasp` box in the `avc1`/`mp4v` sample entry.

`pixelAspectRatio()`: `SAR = (darNum·H) / (darDen·W)`, reduced by gcd.

Key traps:
- **Use DISPLAY dims, not coded.** `StoredHeight` is per-field for interlaced (288 for 576i, 544 for 1080i). Transcode path passes `displayWidth/displayHeight` into `enableTranscodeMode`; native H.264 falls back to coded dims (fine — all AVC content here is square).
- **Near-square snaps to 1:1.** Returns null within 2% of square — absorbs 1088-coded/1080-display rounding (`136:135` → omitted).
- Absent/invalid `AspectRatio` → no `pasp` → 1:1.
- The 1088-vs-1080 vertical padding is a separate pre-existing limitation; `pasp` only corrects horizontal pixel shape. Regression: `tests/aspect-ratio.test.ts`.

`ManifestData` carries `displayWidth`/`displayHeight` (active picture, not per-field `StoredHeight`) and `aspectRatio: {num,den} | null`.
