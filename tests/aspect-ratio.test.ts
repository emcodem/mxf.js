import { describe, it, expect } from 'vitest';
import { Mp4Fragmenter } from '../src/remuxer/mp4-fragmenter.js';
import { pasp } from '../src/remuxer/mp4-boxes.js';
import type { MxfMetadata } from '../src/parser/metadata.js';
import type { PictureDescriptor, VideoCodec } from '../src/parser/descriptor.js';

// Minimal valid-ish SPS/PPS for the avcC box (avcC reads sps[1..3] as profile/compat/level).
const SPS = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xaa, 0xbb]);
const PPS = new Uint8Array([0x68, 0x11, 0x22]);

function pictureDescriptor(over: Partial<PictureDescriptor> & { codec: VideoCodec }): PictureDescriptor {
  return {
    width: 0, height: 0, storedWidth: 0, storedHeight: 0,
    frameRateNumerator: 25, frameRateDenominator: 1,
    aspectRatioNum: 0, aspectRatioDen: 0,
    spsNALU: null, ppsNALU: null, pictureEssenceCodingUL: null,
    ...over,
  };
}

function metadata(pd: PictureDescriptor): MxfMetadata {
  return {
    duration: 100n,
    editRateNumerator: 25, editRateDenominator: 1,
    packages: [],
    timecodes: [],
    pictureDescriptor: pd,
    soundDescriptor: null,
    operationalPattern: null,
  };
}

/** Find a 'pasp' box in an fmp4 buffer and return its [hSpacing, vSpacing], or null if absent. */
function findPasp(buf: Uint8Array): [number, number] | null {
  for (let i = 0; i + 16 <= buf.length; i++) {
    if (buf[i] === 0x70 && buf[i + 1] === 0x61 && buf[i + 2] === 0x73 && buf[i + 3] === 0x70) {
      const dv = new DataView(buf.buffer, buf.byteOffset + i + 4, 8);
      return [dv.getUint32(0, false), dv.getUint32(1 * 4, false)];
    }
  }
  return null;
}

describe('pasp box (anamorphic display aspect ratio)', () => {
  it('emits SAR 64:45 for 720×576 stored at DAR 16:9 (anamorphic SD, raw mp4v path)', () => {
    const f = new Mp4Fragmenter(metadata(pictureDescriptor({
      codec: 'mpeg2', storedWidth: 720, storedHeight: 576, aspectRatioNum: 16, aspectRatioDen: 9,
    })));
    expect(findPasp(f.buildInitSegment(false))).toEqual([64, 45]);
  });

  it('emits SAR 4:3 for XDCAM-EX 1440×1080 display at DAR 16:9 (transcode path)', () => {
    const f = new Mp4Fragmenter(metadata(pictureDescriptor({
      codec: 'mpeg2', storedWidth: 1440, storedHeight: 1080, aspectRatioNum: 16, aspectRatioDen: 9,
    })));
    // coded 1440×1088 (MB-padded), display 1440×1080 — pasp must be derived from the DISPLAY dims.
    f.enableTranscodeMode(SPS, PPS, 1440, 1088, 1440, 1080);
    expect(findPasp(f.buildInitSegment(false))).toEqual([4, 3]);
  });

  it('emits NO pasp for genuinely square 1920×1080 at DAR 16:9', () => {
    const f = new Mp4Fragmenter(metadata(pictureDescriptor({
      codec: 'mpeg2', storedWidth: 1920, storedHeight: 1080, aspectRatioNum: 16, aspectRatioDen: 9,
    })));
    f.enableTranscodeMode(SPS, PPS, 1920, 1088, 1920, 1080);
    expect(findPasp(f.buildInitSegment(false))).toBeNull();
  });

  it('snaps coded-vs-display padding to square: coded 1920×1088, no display dims, DAR 16:9 → no pasp', () => {
    const f = new Mp4Fragmenter(metadata(pictureDescriptor({
      codec: 'mpeg2', storedWidth: 1920, storedHeight: 1080, aspectRatioNum: 16, aspectRatioDen: 9,
    })));
    // Coded 1088 supplied, but NO display dims → pasp falls back to coded dims: 1920×1088 vs 16:9
    // = 136:135 ≈ 1.0074, inside the 2% square tolerance → omitted (no spurious anamorphic stretch).
    f.enableTranscodeMode(SPS, PPS, 1920, 1088);
    expect(findPasp(f.buildInitSegment(false))).toBeNull();
  });

  it('emits NO pasp when the descriptor has no AspectRatio (fallback 1:1)', () => {
    const f = new Mp4Fragmenter(metadata(pictureDescriptor({
      codec: 'mpeg2', storedWidth: 720, storedHeight: 576, // aspectRatio left 0/0
    })));
    expect(findPasp(f.buildInitSegment(false))).toBeNull();
  });

  it('pasp box is well-formed (size + type + two u32)', () => {
    const b = pasp(64, 45);
    expect(b.length).toBe(16); // 8 header + 8 payload
    expect(String.fromCharCode(b[4], b[5], b[6], b[7])).toBe('pasp');
  });
});
