# src/parser/ — metadata + timecode traps

## Header-metadata parse trap: Descriptive Metadata sets (`metadata.ts`)

`parseHeaderMetadata` stops at the first non-header KLV. The boundary test must stop **only** on index/partition (`k[10]===0x02`) or essence (`k[10]===0x03`). DM sets (`0x04`) are valid header metadata and can appear before the essence descriptor — stopping on them drops video/audio descriptors → `pictureDescriptor=null`. DM sets and dark sets are parsed and ignored by class match.

## Timecode (`timecode.ts`, `metadata.ts`)

Two sources, one `timecode` event (`{editUnit, primary, all}`). TC locked to on-screen frame via `requestVideoFrameCallback` (`editUnit = round(mediaTime·fps)`), `timeupdate` fallback.

- **Computed package TC**: `StartTimecode 0x1501` + `editUnit` offset. Pure function of rendered edit unit — no pipeline plumbing. Flagged `reliable:false` in `none`/percentage index mode.
- **System Item per-frame TC**: stashed per content package, attached to next picture frame's `EssenceFrame.systemTimecode`. Emitted as sparse anchors on `videoSegment.systemTcAnchors` (`{editUnit, frameCount, base, dropFrame}`), keyed by **storage edit unit** (not presentation PTS — keying by PTS scrambles non-monotonic B-frame streams). Player resolves as nearest-preceding-anchor + offset.
- **Layout**: tries ST 385 offsets 40 then 23, then `0x81`-marker scan; range-checks every candidate. Unknown layout → null (never a wrong value). Use `node scripts/verify-meta.mjs <file>` to inspect raw bytes per format. Regression: `tests/timecode.test.ts`.
