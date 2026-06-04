import { DataViewReader, u32BE, i32BE, i64BE } from '../core/data-view-reader.js';
import { KLVIterator } from '../core/klv.js';
import { PrimerPack } from './primer.js';
import { PictureDescriptor, SoundDescriptor, identifyVideoCodec } from './descriptor.js';
import { ulMatchClass, formatUL, bytesEqual } from '../core/ul.js';

export type EssenceKind = 'picture' | 'sound' | 'data' | 'timecode';

export interface MxfTrack {
  trackId: number;
  trackNumber: number;
  essence: EssenceKind;
  editRateNumerator: number;
  editRateDenominator: number;
  origin: bigint;
  /**
   * For a timecode track: the start timecode from its TimecodeComponent. `position` is the start
   * frame count (since 00:00:00:00), `base` the RoundedTimecodeBase (frames/sec), `dropFrame` the
   * drop-frame flag. Absent for non-timecode tracks or when no TimecodeComponent is found.
   */
  startTimecode?: { position: bigint; base: number; dropFrame: boolean };
}

export interface MxfPackage {
  packageType: 'material' | 'file' | 'source';
  packageUID: Uint8Array;
  tracks: MxfTrack[];
}

/**
 * A header-metadata timecode track's start point, surfaced once per package that has one. The
 * running timecode for a rendered frame is computed as `position + absoluteEditUnit`, formatted at
 * `base`/`dropFrame`. Reliable only when the absolute edit unit is exact (cbg/vbe index modes).
 */
export interface MxfTimecodeTrack {
  source: 'material' | 'file' | 'source';
  position: bigint;
  base: number;
  dropFrame: boolean;
  editRateNumerator: number;
  editRateDenominator: number;
}

export interface MxfMetadata {
  duration: bigint;
  editRateNumerator: number;
  editRateDenominator: number;
  packages: MxfPackage[];
  /** Start timecodes from the Material / File / Source package timecode tracks (one per package). */
  timecodes: MxfTimecodeTrack[];
  pictureDescriptor: PictureDescriptor | null;
  soundDescriptor: SoundDescriptor | null;
  operationalPattern: Uint8Array | null;
}

// ── Well-known local tags (standard fixed assignments in SMPTE 377) ───────────
const TAG_INSTANCE_UID    = 0x3c0a;
const TAG_TRACKS          = 0x4403;
const TAG_TRACK_ID        = 0x4801;
const TAG_TRACK_NUMBER    = 0x4804;
const TAG_EDIT_RATE       = 0x4b01;
const TAG_ORIGIN          = 0x4b02;
const TAG_SEQUENCE        = 0x4803;
const TAG_DURATION        = 0x0202;
const TAG_PACKAGE_UID     = 0x4401;
const TAG_DATA_DEFINITION = 0x0201;
const TAG_STRUCTURAL_COMPONENTS = 0x1001; // Sequence → array of component strong-refs
const TAG_START_TIMECODE  = 0x1501;       // TimecodeComponent: Position (int64)
const TAG_ROUNDED_TC_BASE = 0x1502;       // TimecodeComponent: RoundedTimecodeBase (uint16)
const TAG_DROP_FRAME      = 0x1503;       // TimecodeComponent: DropFrame (boolean)

// ── Class ULs for metadata Sets ───────────────────────────────────────────────
// Compared with ulMatchClass (bytes 0-4 + 8-15) to tolerate encoder variation
// in bytes 5-7 (item designator / spec version).
// Format: 06 0E 2B 34 02 53 01 01 | 0D 01 01 01 01 01 XX 00
function cls(...b: number[]): Uint8Array { return new Uint8Array(b); }

const CLASS_MATERIAL_PACKAGE = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x36,0x00);
const CLASS_FILE_PACKAGE     = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x37,0x00);
const CLASS_SOURCE_PACKAGE   = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x38,0x00);
const CLASS_STATIC_TRACK     = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x3a,0x00);
const CLASS_TRACK            = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x3b,0x00);
const CLASS_SEQUENCE         = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x0f,0x00);
const CLASS_TIMECODE_COMPONENT = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x14,0x00);
// Descriptor sets
const CLASS_CDCI_DESCRIPTOR     = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x28,0x00);
const CLASS_RGBA_DESCRIPTOR     = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x29,0x00);
const CLASS_MPEGVID_DESCRIPTOR  = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x51,0x00);
const CLASS_AVC_DESCRIPTOR      = cls(0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x5a,0x00);
// (Sound descriptors are detected by their audio local tags, not class UL — see below.)

// ── Data definition ULs (for track type identification) ────────────────────────
// Only bytes 8-15 are significant; bytes 5-7 vary by spec version.
// ulMatchClass ignores bytes 5-7, so one variant per essence type covers all encoders
const DD_PICTURE  = cls(0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x01,0x01,0x03,0x02,0x02,0x01,0x00,0x00,0x00);
const DD_SOUND    = cls(0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x01,0x01,0x03,0x02,0x02,0x02,0x00,0x00,0x00);
const DD_TIMECODE = cls(0x06,0x0e,0x2b,0x34,0x04,0x01,0x01,0x01,0x01,0x03,0x02,0x01,0x01,0x00,0x00,0x00);

// ── Dynamic local-tag aliasing (Primer Pack) ──────────────────────────────────
// MXF local tags below 0x8000 are statically registered, and the standard items this parser reads
// (StoredWidth, ChannelCount, …) always use their static tags — so for conformant files the Primer
// is informational. A file MAY instead assign a DYNAMIC tag (0x8000+) to an item, resolvable only
// through the Primer's tag→UL map. This table aliases such a UL back to the canonical static tag we
// read. It is intentionally empty until validated against a real dynamic-tag file (shipping
// speculative ULs would risk mis-aliasing); the mechanism + plumbing are in place and tested so
// adding an entry is a one-liner. See remapDynamicTags.
interface DynamicTagAlias { ul: Uint8Array; tag: number; }
const DYNAMIC_TAG_ALIASES: DynamicTagAlias[] = [];

/**
 * Resolve dynamic local tags (0x8000+) in a parsed set to the canonical static tags this parser
 * understands, using the Primer's tag→UL map. No-op for the common case (canonical tag already
 * present, or no dynamic tags / no aliases). Exported for direct testing.
 */
export function remapDynamicTags(
  items: Map<number, Uint8Array>,
  primer: PrimerPack,
  aliases: DynamicTagAlias[] = DYNAMIC_TAG_ALIASES,
): void {
  if (aliases.length === 0 || primer.size === 0) return;
  for (const alias of aliases) {
    if (items.has(alias.tag)) continue; // canonical tag already present — nothing to alias
    for (const [tag, ul] of primer) {
      if (tag < 0x8000) continue;        // only dynamic tags need Primer resolution
      if (bytesEqual(ul, alias.ul) && items.has(tag)) {
        items.set(alias.tag, items.get(tag)!);
        break;
      }
    }
  }
}

// ── Raw set representation ────────────────────────────────────────────────────
interface RawSet {
  classUL: Uint8Array;
  instanceUID: Uint8Array;
  localItems: Map<number, Uint8Array>;
}

function parseLocalTagItems(buffer: ArrayBuffer, valueOffset: number, valueLength: number): Map<number, Uint8Array> {
  const r = new DataViewReader(buffer, valueOffset);
  const end = valueOffset + valueLength;
  const items = new Map<number, Uint8Array>();
  while (r.offset + 4 <= end) {
    const tag = r.readU16BE();
    const len = r.readU16BE();
    if (r.offset + len > end) break;
    items.set(tag, r.readBytesCopy(len));
  }
  return items;
}

// ── Public parser ─────────────────────────────────────────────────────────────

export function parseHeaderMetadata(
  buffer: ArrayBuffer,
  metadataOffset: number,
  metadataLength: number,
  primer: PrimerPack,
  debug = false
): MxfMetadata {
  const iter = new KLVIterator(buffer, metadataOffset);
  const end = metadataOffset + metadataLength;

  const sets: RawSet[] = [];

  while (iter.offset < end && iter.hasMore()) {
    const pkt = iter.next();
    if (!pkt) {
      // A malformed set in the middle of the metadata must not silently truncate everything after
      // it (a broken file may still carry a usable picture/sound descriptor further on). Try to
      // resync to the next valid KLV; only stop if none remains.
      if (iter.resync()) continue;
      break;
    }

    const k = pkt.key;
    // Skip KLV fill (06 0E 2B 34 01 01 01 02 03 01 02 10 …) that may sit between/after sets.
    if (k[8] === 0x03 && k[9] === 0x01 && k[10] === 0x02 && k[11] === 0x10) continue;
    // Stop at the first non-metadata KLV so we can safely read past an understated headerByteCount
    // (XAVC, D-10) without mis-parsing index/essence as sets. Header-metadata sets are keyed
    // 06 0E 2B 34 .. 0D 01 01 01 .. (byte10 === 0x01); Index Table Segments and partition packs are
    // 0D 01 02 01 (byte10 === 0x02) and Generic Container essence is 0D 01 03 01 (byte10 === 0x03).
    // Descriptive Metadata sets are 0D 01 04 01 (byte10 === 0x04) and ARE header metadata — they can
    // be interleaved among the structural sets (e.g. an SD MPEG-2 file with DM static tracks places
    // them before the essence descriptor). So only byte10 0x02/0x03 ends the metadata region; an
    // earlier `byte10 !== 0x01` test broke on the first DM set and dropped every descriptor/package
    // after it (→ video=undefined). Everything else (incl. dark/unknown sets) is still parsed.
    if (k[8] === 0x0d && k[9] === 0x01 && (k[10] === 0x02 || k[10] === 0x03)) break;

    const localItems = parseLocalTagItems(buffer, pkt.valueOffset, pkt.valueLength);
    remapDynamicTags(localItems, primer); // resolve any dynamic local tags to canonical ones
    const instanceUID = localItems.get(TAG_INSTANCE_UID) ?? new Uint8Array(16);
    const classUL = new Uint8Array(pkt.key);

    sets.push({ classUL, instanceUID, localItems });
  }

  if (debug) {
    console.log(`[mxf.js] parseHeaderMetadata: ${sets.length} sets found`);
    const seen = new Set<string>();
    for (const s of sets) {
      const h = formatUL(s.classUL);
      if (!seen.has(h)) { seen.add(h); console.log(`  class UL: ${h}`); }
    }
  }

  let pictureDescriptor: PictureDescriptor | null = null;
  let soundDescriptor: SoundDescriptor | null = null;
  let maxDuration = 0n;
  let editRateNumerator = 25;
  let editRateDenominator = 1;
  const packages: MxfPackage[] = [];
  const timecodes: MxfTimecodeTrack[] = [];

  for (const set of sets) {
    const cls = set.classUL;

    if (ulMatchClass(cls, CLASS_CDCI_DESCRIPTOR) ||
        ulMatchClass(cls, CLASS_RGBA_DESCRIPTOR) ||
        ulMatchClass(cls, CLASS_MPEGVID_DESCRIPTOR) ||
        ulMatchClass(cls, CLASS_AVC_DESCRIPTOR)) {
      pictureDescriptor = parsePictureDescriptorFromSet(set);
      if (debug) console.log(`[mxf.js] found picture descriptor: codec=${pictureDescriptor.codec} ${pictureDescriptor.storedWidth}x${pictureDescriptor.storedHeight} AR=${pictureDescriptor.aspectRatioNum||'-'}/${pictureDescriptor.aspectRatioDen||'-'}`);
    }

    // Detect a sound descriptor by the presence of audio local tags rather than by descriptor
    // class UL. All uncompressed audio is treated as PCM (WaveAudio, AES3, GenericSound, and the
    // various sub-classed sound descriptors all just carry sample rate / channel count / bit depth);
    // matching on class missed e.g. XAVC's sound descriptor whose class UL isn't one of the
    // canonical four. Tags 0x3D01/0x3D03/0x3D07 are audio-specific (picture uses 0x32xx).
    if (!soundDescriptor &&
        (set.localItems.has(0x3d03) || set.localItems.has(0x3d07) || set.localItems.has(0x3d01))) {
      soundDescriptor = parseSoundDescriptorFromSet(set);
      if (debug) console.log(`[mxf.js] found sound descriptor: codec=${soundDescriptor.codec} ${soundDescriptor.sampleRate}Hz ${soundDescriptor.channelCount}ch ${soundDescriptor.bitDepth}bit`);
    }

    if (ulMatchClass(cls, CLASS_MATERIAL_PACKAGE) ||
        ulMatchClass(cls, CLASS_FILE_PACKAGE) ||
        ulMatchClass(cls, CLASS_SOURCE_PACKAGE)) {
      const pkg = parsePackage(cls, set, sets, debug);
      packages.push(pkg);
      for (const track of pkg.tracks) {
        if (pkg.packageType === 'material' && track.essence === 'picture') {
          editRateNumerator = track.editRateNumerator;
          editRateDenominator = track.editRateDenominator;
        }
        if (track.essence === 'timecode' && track.startTimecode) {
          const st = track.startTimecode;
          timecodes.push({
            source: pkg.packageType,
            position: st.position,
            // RoundedTimecodeBase is authoritative; fall back to the track's edit rate when absent.
            base: st.base > 0 ? st.base
              : (track.editRateDenominator > 0 ? Math.round(track.editRateNumerator / track.editRateDenominator) : 0),
            dropFrame: st.dropFrame,
            editRateNumerator: track.editRateNumerator,
            editRateDenominator: track.editRateDenominator,
          });
        }
      }
    }
  }

  for (const set of sets) {
    if (ulMatchClass(set.classUL, CLASS_SEQUENCE)) {
      const dur = set.localItems.get(TAG_DURATION);
      if (dur && dur.length >= 8) {
        const d = i64BE(dur);
        if (d > maxDuration) maxDuration = d;
      }
    }
  }

  if (debug) {
    console.log(`[mxf.js] duration=${maxDuration} editRate=${editRateNumerator}/${editRateDenominator} packages=${packages.length}`);
  }

  return {
    duration: maxDuration,
    editRateNumerator,
    editRateDenominator,
    packages,
    timecodes,
    pictureDescriptor,
    soundDescriptor,
    operationalPattern: null,
  };
}

function parsePictureDescriptorFromSet(set: RawSet): PictureDescriptor {
  const width = set.localItems.get(0x3203);
  const height = set.localItems.get(0x3202);
  const sr = set.localItems.get(0x3001);
  const pec = set.localItems.get(0x3201);
  const ar = set.localItems.get(0x320e); // AspectRatio (DAR) — Rational(int32 num, int32 den)

  // Also check for SampleRate stored as rational
  let frameRateNum = 25, frameRateDen = 1;
  if (sr && sr.length >= 8) {
    frameRateNum = i32BE(sr);
    frameRateDen = new DataView(sr.buffer, sr.byteOffset, sr.byteLength).getInt32(4, false);
    if (frameRateDen <= 0) frameRateDen = 1;
  }

  // AspectRatio is optional: parse it when present and well-formed, else leave 0/0 (→ square pixels).
  let aspectRatioNum = 0, aspectRatioDen = 0;
  if (ar && ar.length >= 8) {
    const n = i32BE(ar);
    const d = new DataView(ar.buffer, ar.byteOffset, ar.byteLength).getInt32(4, false);
    if (n > 0 && d > 0) { aspectRatioNum = n; aspectRatioDen = d; }
  }

  return {
    codec: pec && pec.length >= 16 ? identifyVideoCodec(pec) : 'unknown',
    width:        width && width.length >= 4 ? u32BE(width) : 0,
    height:       height && height.length >= 4 ? u32BE(height) : 0,
    storedWidth:  width && width.length >= 4 ? u32BE(width) : 0,
    storedHeight: height && height.length >= 4 ? u32BE(height) : 0,
    frameRateNumerator:   frameRateNum,
    frameRateDenominator: frameRateDen,
    aspectRatioNum,
    aspectRatioDen,
    spsNALU: null,
    ppsNALU: null,
    pictureEssenceCodingUL: pec ?? null,
  };
}

function parseSoundDescriptorFromSet(set: RawSet): SoundDescriptor {
  const asr = set.localItems.get(0x3d03);
  const cc  = set.localItems.get(0x3d07);
  const qb  = set.localItems.get(0x3d01);
  // BlockAlign is local tag 0x3D0A. (0x3D09 is AvgBytesPerSecond — reading that here gave a
  // ~144000 "block align" for 24-bit mono, which collapsed PCM decode to zero samples = silence.)
  const ba  = set.localItems.get(0x3d0a);

  const sampleRate    = asr && asr.length >= 4 ? i32BE(asr) : 48000;
  const channelCount  = cc  && cc.length  >= 4 ? u32BE(cc)  : 2;
  const bitDepth      = qb  && qb.length  >= 4 ? u32BE(qb)  : 16;
  const blockAlign    = ba  && ba.length  >= 4 ? u32BE(ba)  : channelCount * (bitDepth / 8);

  return { codec: 'pcm', sampleRate, channelCount, bitDepth, blockAlign };
}

function parsePackage(classUL: Uint8Array, set: RawSet, allSets: RawSet[], debug: boolean): MxfPackage {
  const packageType: MxfPackage['packageType'] =
    ulMatchClass(classUL, CLASS_MATERIAL_PACKAGE) ? 'material' :
    ulMatchClass(classUL, CLASS_FILE_PACKAGE) ? 'file' : 'source';

  const packageUID = set.localItems.get(TAG_PACKAGE_UID)?.slice(0, 32) ?? new Uint8Array(32);
  const tracksData = set.localItems.get(TAG_TRACKS);
  const tracks: MxfTrack[] = [];

  if (tracksData && tracksData.length >= 8) {
    const v = new DataView(tracksData.buffer, tracksData.byteOffset, tracksData.byteLength);
    const count = v.getUint32(0, false);
    const itemLen = v.getUint32(4, false);
    if (debug) console.log(`[mxf.js] package ${packageType}: ${count} track refs (itemLen=${itemLen})`);

    for (let i = 0; i < count; i++) {
      const refUID = tracksData.slice(8 + i * itemLen, 8 + (i + 1) * itemLen);
      const trackSet = allSets.find(s =>
        (ulMatchClass(s.classUL, CLASS_TRACK) || ulMatchClass(s.classUL, CLASS_STATIC_TRACK)) &&
        bytesEqual(s.instanceUID, refUID.slice(0, 16))
      );
      if (trackSet) {
        tracks.push(parseTrack(trackSet, allSets));
      } else if (debug) {
        console.log(`  track ref not found: ${formatUL(refUID.slice(0, 16))}`);
      }
    }
  }

  return { packageType, packageUID, tracks };
}

function parseTrack(set: RawSet, allSets: RawSet[]): MxfTrack {
  const trackId  = set.localItems.get(TAG_TRACK_ID);
  const trackNum = set.localItems.get(TAG_TRACK_NUMBER);
  const editRate = set.localItems.get(TAG_EDIT_RATE);
  const origin   = set.localItems.get(TAG_ORIGIN);
  const seqRef   = set.localItems.get(TAG_SEQUENCE);

  let essence: EssenceKind = 'data';
  let startTimecode: MxfTrack['startTimecode'];

  if (seqRef && seqRef.length >= 16) {
    const seqSet = allSets.find(s =>
      ulMatchClass(s.classUL, CLASS_SEQUENCE) &&
      bytesEqual(s.instanceUID, seqRef.slice(0, 16))
    );
    if (seqSet) {
      const dd = seqSet.localItems.get(TAG_DATA_DEFINITION);
      if (dd && dd.length >= 16) {
        const ddSlice = dd.slice(0, 16);
        // Use ulMatchClass: ignores bytes 5-7 (version bytes that vary between encoders)
        if (ulMatchClass(ddSlice, DD_PICTURE)) essence = 'picture';
        else if (ulMatchClass(ddSlice, DD_SOUND)) essence = 'sound';
        else if (ulMatchClass(ddSlice, DD_TIMECODE)) essence = 'timecode';
      }
    }
    // Resolve the track's TimecodeComponent (the start timecode), whether the track references a
    // Sequence containing it or the component directly.
    startTimecode = findStartTimecode(seqRef.slice(0, 16), allSets);
  }

  let erNum = 25, erDen = 1;
  if (editRate && editRate.length >= 8) {
    erNum = i32BE(editRate);
    erDen = new DataView(editRate.buffer, editRate.byteOffset, editRate.byteLength).getInt32(4, false);
    if (erDen <= 0) erDen = 1;
  }

  return {
    trackId:   trackId  && trackId.length  >= 4 ? u32BE(trackId) : 0,
    trackNumber: trackNum && trackNum.length >= 4 ? u32BE(trackNum) : 0,
    essence,
    editRateNumerator: erNum,
    editRateDenominator: erDen,
    origin: origin && origin.length >= 8 ? i64BE(origin) : 0n,
    startTimecode,
  };
}

/**
 * Resolve the TimecodeComponent reachable from a track's Sequence ref and read its start timecode.
 * The ref may point to a Sequence (walk its StructuralComponents array, tag 0x1001) or directly to
 * a TimecodeComponent. Returns undefined if no TimecodeComponent / StartTimecode is found.
 */
function findStartTimecode(refUID: Uint8Array, allSets: RawSet[]): MxfTrack['startTimecode'] {
  const refSet = allSets.find(s => bytesEqual(s.instanceUID, refUID));
  if (!refSet) return undefined;

  let tcSet: RawSet | undefined;
  if (ulMatchClass(refSet.classUL, CLASS_TIMECODE_COMPONENT)) {
    tcSet = refSet;
  } else {
    const comps = refSet.localItems.get(TAG_STRUCTURAL_COMPONENTS);
    if (comps && comps.length >= 8) {
      const v = new DataView(comps.buffer, comps.byteOffset, comps.byteLength);
      const count = v.getUint32(0, false);
      const itemLen = v.getUint32(4, false);
      for (let i = 0; i < count && itemLen >= 16; i++) {
        const uid = comps.slice(8 + i * itemLen, 8 + i * itemLen + 16);
        const cand = allSets.find(s =>
          ulMatchClass(s.classUL, CLASS_TIMECODE_COMPONENT) && bytesEqual(s.instanceUID, uid));
        if (cand) { tcSet = cand; break; }
      }
    }
  }
  if (!tcSet) return undefined;

  const start = tcSet.localItems.get(TAG_START_TIMECODE);
  if (!start || start.length < 8) return undefined;
  const baseB = tcSet.localItems.get(TAG_ROUNDED_TC_BASE);
  const dropB = tcSet.localItems.get(TAG_DROP_FRAME);
  const base = baseB && baseB.length >= 2
    ? new DataView(baseB.buffer, baseB.byteOffset, baseB.byteLength).getUint16(0, false) : 0;
  return {
    position: i64BE(start),
    base,
    dropFrame: !!(dropB && dropB.length >= 1 && dropB[0] !== 0),
  };
}
