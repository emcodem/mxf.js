# src/ — player + file-level traps

## Seek modes (`mxf-player.ts`)

- **`MxfConfig.seekMode: 'accurate' | 'keyframe'`** (default `'accurate'`).
- **`beginScrub()` / `endScrub()`**: scrub forces keyframe mode; `endScrub()` issues one accurate seek to settle.
- **`previewParked`**: blocks `fetchNextChunk` after a keyframe preview — decoder counter has advanced past the keyframe. Cleared by `play()`/`endScrub()`/any new seek.
- **GOP keyframe flag**: `(flags & 0x80) === 0` — convention, unverified.

## XAVC / AVC-Intra: in-header-partition index + essence start (`mxf-file.ts`, `src/core/ul.ts`, `src/essence/avc-tools.ts`)

XAVC OP1a files put essence in the **header partition** (`bodySID=1`) with a CBG index between `headerByteCount` and the first essence KLV. `headerByteCount` is understated; no footer index.

- **`MxfFile.locateEssence`**: KLV-walks the essence-bearing partition (chosen via RIP `bodySID>0` entry), collecting index segments, stopping at the first Generic Container element (`isGenericContainerElement`: key bytes [8..11] = `0D 01 03 01`). Byte-count math is not trusted.
- **RIP UL** (`UL_RANDOM_INDEX_PACK` in `src/core/ul.ts`): must include byte-12 `01` — `…02 01 01 11 01 00`, not `…02 01 11 01 00 00`.
- **SPS-derived avc1 dims** (`parseSPSCodedDimensions` in `src/essence/avc-tools.ts`): interlaced AVC-Intra (1080i, `frame_mbs_only_flag=0`) is MBAFF at full 1088 height; MXF descriptor stores per-field `StoredHeight=544`. The avc1 box must use SPS coded dims (1920×1088), not the descriptor.
