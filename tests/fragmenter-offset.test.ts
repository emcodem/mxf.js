import { describe, it, expect } from 'vitest';
import { Mp4Fragmenter } from '../src/remuxer/mp4-fragmenter.js';
import type { MxfMetadata } from '../src/parser/metadata.js';
import type { PictureDescriptor, SoundDescriptor, VideoCodec } from '../src/parser/descriptor.js';
import type { EssenceFrame } from '../src/essence/essence-extractor.js';

// 25 fps → 90000-tick timescale → 3600 ticks/frame. The playlist global offset shifts a clip's
// baseMediaDecodeTime by frameOffset × frameDurationTicks so clips tile on one MSE timeline.
const TICKS_PER_FRAME = 3600;

function pictureDescriptor(): PictureDescriptor {
  return {
    codec: 'h264' as VideoCodec,
    width: 1920, height: 1080, storedWidth: 1920, storedHeight: 1080,
    frameRateNumerator: 25, frameRateDenominator: 1,
    aspectRatioNum: 0, aspectRatioDen: 0,
    spsNALU: null, ppsNALU: null, pictureEssenceCodingUL: null,
  };
}

function soundDescriptor(): SoundDescriptor {
  return { codec: 'pcm', sampleRate: 48000, channelCount: 2, bitDepth: 24, blockAlign: 6 } as SoundDescriptor;
}

function metadata(): MxfMetadata {
  return {
    duration: 100n,
    editRateNumerator: 25, editRateDenominator: 1,
    packages: [], timecodes: [],
    pictureDescriptor: pictureDescriptor(),
    soundDescriptor: soundDescriptor(),
    operationalPattern: null,
  };
}

const SPS = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xaa, 0xbb]);
const PPS = new Uint8Array([0x68, 0x11, 0x22]);

function videoFrame(editUnit: number, isKeyframe: boolean): EssenceFrame {
  const eu = BigInt(editUnit);
  // A trivial AVCC NAL (4-byte length + 1 byte) so the remux path has bytes to package.
  const data = new Uint8Array([0, 0, 0, 1, 0x65]).buffer;
  return { trackType: 'video', editUnit: eu, pts: eu, dts: eu, isKeyframe, data };
}

/** Read the tfdt (version 1) baseMediaDecodeTime from an fmp4 media segment. */
function readBaseMediaDecodeTime(seg: Uint8Array): bigint {
  for (let i = 0; i + 8 <= seg.length; i++) {
    if (seg[i] === 0x74 && seg[i + 1] === 0x66 && seg[i + 2] === 0x64 && seg[i + 3] === 0x74) { // 'tfdt'
      const dv = new DataView(seg.buffer, seg.byteOffset + i + 4, 12);
      const version = dv.getUint8(0);
      if (version === 1) return dv.getBigUint64(4, false);
      return BigInt(dv.getUint32(4, false));
    }
  }
  throw new Error('tfdt not found');
}

describe('Mp4Fragmenter global frame offset (playlist tiling)', () => {
  it('shifts video baseMediaDecodeTime by frameOffset × frameDurationTicks', () => {
    const f = new Mp4Fragmenter(metadata());
    f.setSPSPPS([SPS], [PPS]);
    f.buildInitSegment(false); // establishes config (timescale / ticks-per-frame)

    const frames = [videoFrame(0, true), videoFrame(1, false)];
    const base0 = readBaseMediaDecodeTime(f.buildVideoSegment(frames, 0)!);
    const base500 = readBaseMediaDecodeTime(f.buildVideoSegment(frames, 500)!);

    expect(base0).toBe(0n);
    expect(base500).toBe(BigInt(500 * TICKS_PER_FRAME));
  });

  it('shifts transcoded video baseMediaDecodeTime by the same offset', () => {
    const f = new Mp4Fragmenter(metadata());
    f.enableTranscodeMode(SPS, PPS, 1920, 1088, 1920, 1080);
    f.buildInitSegment(false);

    const chunks = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65]).buffer, isKeyframe: true, editUnit: 0n },
      { data: new Uint8Array([0, 0, 0, 1, 0x41]).buffer, isKeyframe: false, editUnit: 1n },
    ];
    const base0 = readBaseMediaDecodeTime(f.buildTranscodedVideoSegment(chunks, undefined, 0)!);
    const base250 = readBaseMediaDecodeTime(f.buildTranscodedVideoSegment(chunks, undefined, 250)!);

    expect(base0).toBe(0n);
    expect(base250).toBe(BigInt(250 * TICKS_PER_FRAME));
  });
});
