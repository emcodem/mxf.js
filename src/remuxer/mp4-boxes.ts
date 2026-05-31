// Low-level MP4 box builders. Each function returns a Uint8Array.
// All integers are big-endian as required by ISOBMFF.

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function u32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function u16BE(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, false);
  return b;
}

function u8(n: number): Uint8Array {
  return new Uint8Array([n]);
}

function str4(s: string): Uint8Array {
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}

export function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const payload = concat(...children);
  const size = 8 + payload.length;
  return concat(u32BE(size), str4(type), payload);
}

export function fullBox(type: string, version: number, flags: number, ...children: Uint8Array[]): Uint8Array {
  const payload = concat(...children);
  const size = 12 + payload.length;
  return concat(u32BE(size), str4(type), u8(version), u24BE(flags), payload);
}

function u24BE(n: number): Uint8Array {
  return new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function i32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
}

function u64BE(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, Number(n >> 32n) >>> 0, false);
  v.setUint32(4, Number(n & 0xffffffffn) >>> 0, false);
  return b;
}

// ftyp — file type box
export function ftyp(): Uint8Array {
  return box('ftyp',
    str4('isom'),   // major brand
    u32BE(0x200),   // minor version
    str4('isom'), str4('iso2'), str4('avc1'), str4('mp41'), str4('dash')
  );
}

// mvhd — movie header (version 0)
export function mvhd(durationTicks: number, timescale: number): Uint8Array {
  return fullBox('mvhd', 0, 0,
    u32BE(0), u32BE(0),      // creation/modification time
    u32BE(timescale),
    u32BE(durationTicks),
    u32BE(0x00010000),       // rate = 1.0
    u16BE(0x0100),           // volume = 1.0
    new Uint8Array(10),      // reserved
    // unity matrix
    u32BE(0x00010000), u32BE(0), u32BE(0),
    u32BE(0), u32BE(0x00010000), u32BE(0),
    u32BE(0), u32BE(0), u32BE(0x40000000),
    new Uint8Array(24),      // pre-defined
    u32BE(0xffffffff),       // next track ID
  );
}

// tkhd — track header
export function tkhd(trackId: number, durationTicks: number, width: number, height: number, isVideo: boolean): Uint8Array {
  const flags = isVideo ? 3 : 3; // track_enabled | track_in_movie
  return fullBox('tkhd', 0, flags,
    u32BE(0), u32BE(0),     // creation/modification time
    u32BE(trackId),
    u32BE(0),               // reserved
    u32BE(durationTicks),
    new Uint8Array(8),      // reserved
    u16BE(0),               // layer
    u16BE(isVideo ? 0 : 1), // alternate group
    u16BE(isVideo ? 0 : 0x0100), // volume (1.0 for audio)
    u16BE(0),               // reserved
    // unity matrix
    u32BE(0x00010000), u32BE(0), u32BE(0),
    u32BE(0), u32BE(0x00010000), u32BE(0),
    u32BE(0), u32BE(0), u32BE(0x40000000),
    u32BE(isVideo ? width << 16 : 0),   // width (16.16 fixed)
    u32BE(isVideo ? height << 16 : 0),  // height
  );
}

// mdhd — media header
export function mdhd(timescale: number, durationTicks: number): Uint8Array {
  return fullBox('mdhd', 0, 0,
    u32BE(0), u32BE(0),     // creation/modification
    u32BE(timescale),
    u32BE(durationTicks),
    u16BE(0x55c4),          // 'und' language
    u16BE(0),               // pre-defined
  );
}

// hdlr — handler reference
export function hdlr(handlerType: 'vide' | 'soun'): Uint8Array {
  const name = handlerType === 'vide' ? 'Video Handler\0' : 'Sound Handler\0';
  const nameBytes = new TextEncoder().encode(name);
  return fullBox('hdlr', 0, 0,
    u32BE(0),               // pre-defined
    str4(handlerType),
    u32BE(0), u32BE(0), u32BE(0), // reserved
    nameBytes,
  );
}

// vmhd — video media header
export function vmhd(): Uint8Array {
  return fullBox('vmhd', 0, 1, u16BE(0), u16BE(0), u16BE(0), u16BE(0));
}

// smhd — sound media header
export function smhd(): Uint8Array {
  return fullBox('smhd', 0, 0, u16BE(0), u16BE(0));
}

// dref — data reference box (self-contained)
export function dref(): Uint8Array {
  const url = fullBox('url ', 0, 1); // self-contained flag
  return fullBox('dref', 0, 0, u32BE(1), url);
}

// dinf — data information box
export function dinf(): Uint8Array {
  return box('dinf', dref());
}

// stts — empty time-to-sample (MSE sends fragments)
export function stts(): Uint8Array {
  return fullBox('stts', 0, 0, u32BE(0));
}

// stsc — empty sample-to-chunk
export function stsc(): Uint8Array {
  return fullBox('stsc', 0, 0, u32BE(0));
}

// stsz — empty sample sizes
export function stsz(): Uint8Array {
  return fullBox('stsz', 0, 0, u32BE(0), u32BE(0));
}

// stco — empty chunk offset
export function stco(): Uint8Array {
  return fullBox('stco', 0, 0, u32BE(0));
}

// avcC — AVC decoder configuration record
export function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const inner = new Uint8Array([
    1,           // configurationVersion
    sps[1],      // AVCProfileIndication
    sps[2],      // profile_compatibility
    sps[3],      // AVCLevelIndication
    0xff,        // lengthSizeMinusOne=3 (4 bytes)
    0xe1,        // numSPS=1
    (sps.length >> 8) & 0xff, sps.length & 0xff,
    ...sps,
    0x01,        // numPPS=1
    (pps.length >> 8) & 0xff, pps.length & 0xff,
    ...pps,
  ]);
  return box('avcC', inner);
}

// avc1 — AVC sample entry
export function avc1(width: number, height: number, spsNALU: Uint8Array, ppsNALU: Uint8Array): Uint8Array {
  return box('avc1',
    new Uint8Array(6),      // reserved
    u16BE(1),               // data reference index
    new Uint8Array(16),     // pre-defined / reserved
    u16BE(width),
    u16BE(height),
    u32BE(0x00480000),      // horizresolution 72dpi
    u32BE(0x00480000),      // vertresolution  72dpi
    u32BE(0),               // reserved
    u16BE(1),               // frame count
    new Uint8Array(32),     // compressorname
    u16BE(0x0018),          // depth
    u16BE(0xffff),          // pre-defined = int(16) -1
    avcC(spsNALU, ppsNALU),
  );
}

// mp4v — MPEG-4 Visual sample entry (used for MPEG-2 in fmp4 container)
export function mp4v(width: number, height: number): Uint8Array {
  return box('mp4v',
    new Uint8Array(6),
    u16BE(1),
    new Uint8Array(16),
    u16BE(width),
    u16BE(height),
    u32BE(0x00480000),
    u32BE(0x00480000),
    u32BE(0),
    u16BE(1),
    new Uint8Array(32),
    u16BE(0x0018),
    u16BE(0xffff),          // pre-defined = int(16) -1
  );
}

// esds — elementary stream descriptor (minimal, for AAC)
export function esds(aacConfig: Uint8Array): Uint8Array {
  const streamType = 0x15; // audio stream
  const maxBitrate = 320000;
  const avgBitrate = 128000;

  const decoderConfig = new Uint8Array([
    0x04, // ES_Descriptor tag
    ...berEncode(13 + 5 + aacConfig.length),
    0x40, // objectTypeIndication: Audio ISO/IEC 14496-3
    streamType << 2 | 1, // streamType | upStream
    0, 0, 0, // bufferSizeDB
    ...u32BEArr(maxBitrate),
    ...u32BEArr(avgBitrate),
    0x05, // DecoderSpecificInfo tag
    ...berEncode(aacConfig.length),
    ...aacConfig,
    0x06, 0x01, 0x02, // SLConfigDescriptor
  ]);

  const esDesc = new Uint8Array([
    0x03, // ES_Descriptor tag
    ...berEncode(3 + decoderConfig.length),
    0x00, 0x01, // ES_ID
    0x00,       // flags
    ...decoderConfig,
  ]);

  return fullBox('esds', 0, 0, esDesc);
}

function berEncode(len: number): number[] {
  if (len < 0x80) return [len];
  if (len < 0x4000) return [0x80 | (len >> 7), len & 0x7f];
  return [0x80 | (len >> 14), 0x80 | ((len >> 7) & 0x7f), len & 0x7f];
}

function u32BEArr(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

// mp4a — AAC audio sample entry
export function mp4a(sampleRate: number, channelCount: number, aacConfig: Uint8Array): Uint8Array {
  return box('mp4a',
    new Uint8Array(6),
    u16BE(1),
    new Uint8Array(8),
    u16BE(channelCount),
    u16BE(16),             // sample size
    u16BE(0),              // compression ID
    u16BE(0),              // packet size
    u32BE(sampleRate << 16),
    esds(aacConfig),
  );
}

// sowt — signed 16-bit big-endian PCM audio (LPCM in QuickTime/ISO base)
export function sowt(sampleRate: number, channelCount: number, bitDepth: number): Uint8Array {
  return box('sowt',
    new Uint8Array(6),
    u16BE(1),
    new Uint8Array(8),
    u16BE(channelCount),
    u16BE(bitDepth),
    u16BE(0),
    u16BE(0),
    u32BE(sampleRate << 16),
  );
}

// stsd — sample description box
export function stsd(codecBox: Uint8Array): Uint8Array {
  return fullBox('stsd', 0, 0, u32BE(1), codecBox);
}

// minf — media information container
export function minf(mediaHeaderBox: Uint8Array, stblBox: Uint8Array): Uint8Array {
  return box('minf', mediaHeaderBox, dinf(), stblBox);
}

// stbl — sample table (all empty for fmp4)
export function stbl(sampleDescBox: Uint8Array): Uint8Array {
  return box('stbl', sampleDescBox, stts(), stsc(), stsz(), stco());
}

// mdia — media container
export function mdia(timescale: number, durationTicks: number, handlerType: 'vide' | 'soun', mediaHeaderBox: Uint8Array, stblBox: Uint8Array): Uint8Array {
  return box('mdia',
    mdhd(timescale, durationTicks),
    hdlr(handlerType),
    minf(mediaHeaderBox, stblBox),
  );
}

// trak — track container
export function trak(tkhdBox: Uint8Array, mdiaBox: Uint8Array): Uint8Array {
  return box('trak', tkhdBox, mdiaBox);
}

// trex — track extends
export function trex(trackId: number): Uint8Array {
  return fullBox('trex', 0, 0,
    u32BE(trackId),
    u32BE(1),   // default sample description index
    u32BE(0),   // default sample duration
    u32BE(0),   // default sample size
    u32BE(0),   // default sample flags
  );
}

// mvex — movie extends
export function mvex(...trexBoxes: Uint8Array[]): Uint8Array {
  return box('mvex', ...trexBoxes);
}

// moov — movie container
export function moov(...children: Uint8Array[]): Uint8Array {
  return box('moov', ...children);
}

// --- Fragment boxes ---

// mfhd — movie fragment header
export function mfhd(sequenceNumber: number): Uint8Array {
  return fullBox('mfhd', 0, 0, u32BE(sequenceNumber));
}

export interface TrunSample {
  duration: number;
  size: number;
  flags: number;  // 0x00000000 = sync, 0x01000000 = non-sync
  compositionTimeOffset: number; // PTS - DTS in ticks
}

// tfhd — track fragment header
export function tfhd(trackId: number): Uint8Array {
  return fullBox('tfhd', 0, 0x020000, // default-base-is-moof flag
    u32BE(trackId),
  );
}

// tfdt — track fragment decode time
export function tfdt(baseMediaDecodeTime: bigint): Uint8Array {
  return fullBox('tfdt', 1, 0, u64BE(baseMediaDecodeTime));
}

// trun — track run
export function trun(samples: TrunSample[], dataOffset: number): Uint8Array {
  // flags: data-offset-present (0x001) | sample-duration-present (0x100) |
  //        sample-size-present (0x200) | sample-flags-present (0x400) |
  //        sample-composition-time-offsets-present (0x800)
  const flags = 0xf01;
  const sampleData = new Uint8Array(samples.length * 16);
  const sv = new DataView(sampleData.buffer);
  let i = 0;
  for (const s of samples) {
    sv.setUint32(i,      s.duration, false);             i += 4;
    sv.setUint32(i,      s.size,     false);             i += 4;
    sv.setUint32(i,      s.flags,    false);             i += 4;
    sv.setInt32( i,      s.compositionTimeOffset, false); i += 4;
  }

  return fullBox('trun', 1, flags,
    u32BE(samples.length),
    i32BE(dataOffset),
    sampleData,
  );
}

// traf — track fragment
export function traf(trackId: number, decodeTime: bigint, samples: TrunSample[], dataOffset: number): Uint8Array {
  return box('traf',
    tfhd(trackId),
    tfdt(decodeTime),
    trun(samples, dataOffset),
  );
}

// moof — movie fragment
export function moof(sequenceNumber: number, ...trafBoxes: Uint8Array[]): Uint8Array {
  return box('moof', mfhd(sequenceNumber), ...trafBoxes);
}

// mdat — media data
export function mdat(data: Uint8Array): Uint8Array {
  return box('mdat', data);
}
