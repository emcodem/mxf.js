import { ILoader } from './loader/loader.js';
import { KLVIterator, readKLV } from './core/klv.js';
import { parsePartitionPack, PartitionPack } from './parser/partition.js';
import { parsePrimerPack, PrimerPack } from './parser/primer.js';
import { parseHeaderMetadata, MxfMetadata } from './parser/metadata.js';
import { parseIndexTableSegment, IndexTableSegment, classifyIndexMode } from './parser/index-table.js';
import {
  isPartitionPack,
  isPrimerPack,
  isIndexTableSegment,
  isGenericContainerElement,
  ulEquals,
  UL_RANDOM_INDEX_PACK,
  isFill,
} from './core/ul.js';

/** Initial read just to get the Partition Pack (small, fixed size ~120 bytes) */
const PP_READ_SIZE = 512;
const TAIL_READ_SIZE = 65536;

export interface RandomIndexPackEntry {
  bodySID: number;
  byteOffset: bigint;
}

/**
 * Which seeking strategy applies to this file:
 * - 'cbg'  — Constant Byte Group: an index segment declares editUnitByteCount > 0, so any frame's
 *            byte offset is `essenceStart + frame * editUnitByteCount` (no per-frame entries needed).
 * - 'vbe'  — Variable Byte Extent: a normal index entry array maps each frame to a byte offset.
 * - 'none' — No usable index (e.g. still-growing / live files); seek by offset percentage + scan.
 */
export type IndexMode = 'cbg' | 'vbe' | 'none';

export interface MxfBootstrap {
  headerPartition: PartitionPack;
  metadata: MxfMetadata;
  indexSegments: IndexTableSegment[];
  ripEntries: RandomIndexPackEntry[];
  /** Absolute file offset of the first essence KLV in the body partition */
  essenceStart: bigint;
  /** BodySID of the body partition holding the video essence (0 = unknown / match any) */
  essenceBodySID: number;
  /** Seeking strategy this file supports — see {@link IndexMode} */
  indexMode: IndexMode;
}

export class MxfFile {
  private readonly loader: ILoader;
  private readonly debug: boolean;
  private bootstrap: MxfBootstrap | null = null;

  constructor(loader: ILoader, debug = false) {
    this.loader = loader;
    this.debug = debug;
  }

  async open(): Promise<MxfBootstrap> {
    if (this.bootstrap) return this.bootstrap;

    const fileSize = await this.loader.fileSize;

    // ── Step 1: Read just enough to parse the Header Partition Pack ──────────
    // The PP is typically ~120 bytes; 512 is always enough even with run-in.
    const ppBuf = await this.loader.fetchRange(0, Math.min(PP_READ_SIZE, fileSize) - 1, 'bootstrap: header partition pack');
    const ppStartOffset = KLVIterator.skipRunIn(ppBuf);
    const headerPartition = parsePartitionPack(ppBuf, 0);
    const ppKlv = readKLV(ppBuf, ppStartOffset);
    const afterPP = ppStartOffset + ppKlv.totalLength; // file offset of first metadata KLV

    // ── Step 2: Fetch the full header metadata section ────────────────────────
    // headerByteCount = Primer Pack + all metadata Sets (exact byte count from spec).
    // This avoids the problem of hitting large essence KLVs that follow the metadata.
    const metaSize = Number(headerPartition.headerByteCount);
    let metaBuf: ArrayBuffer;

    if (metaSize > 0) {
      metaBuf = await this.loader.fetchRange(afterPP, afterPP + metaSize - 1, 'bootstrap: header metadata');
    } else {
      // Non-conformant file: headerByteCount not set. Heuristic: read 2 MB and stop
      // at the next partition pack boundary inside findHeaderMetadata.
      const fallbackSize = Math.min(2 * 1024 * 1024, fileSize - afterPP);
      metaBuf = await this.loader.fetchRange(afterPP, afterPP + fallbackSize - 1, 'bootstrap: header metadata (fallback)');
    }

    const { primer, metadataStart, metadataLength } = this.findHeaderMetadata(metaBuf);
    if (this.debug) {
      console.log(`[jsmxf] headerByteCount=${metaSize}, metaBuf.length=${metaBuf.byteLength}, metadataStart=${metadataStart}, metadataLength=${metadataLength}`);
    }
    let metadata = parseHeaderMetadata(metaBuf, metadataStart, metadataLength, primer, this.debug);
    metadata = { ...metadata, operationalPattern: headerPartition.operationalPattern };

    // ── Step 3: Read tail to find Random Index Pack ───────────────────────────
    const tailStart = Math.max(0, fileSize - TAIL_READ_SIZE);
    const tailBuf = await this.loader.fetchRange(tailStart, fileSize - 1, 'bootstrap: tail / random index pack');
    const ripEntries = this.parseRandomIndexPack(tailBuf);

    // ── Step 4: Extract Index Table Segments ─────────────────────────────────
    // Many encoders (D-10, some OP1a) embed the index table in the header
    // partition metadata rather than (or in addition to) the footer partition.
    // Scan the already-fetched header buffer first, then check the footer.
    const headerIndexSegments = this.scanBufferForIndexSegments(metaBuf, 0);
    const footerOffset = this.findFooterOffset(ripEntries, headerPartition);
    const footerIndexSegments = await this.fetchIndexSegments(footerOffset, fileSize);
    const indexSegments = [...headerIndexSegments, ...footerIndexSegments];
    if (this.debug && indexSegments.length > 0) {
      console.log(`[jsmxf] indexSegments: ${indexSegments.length} (${headerIndexSegments.length} header, ${footerIndexSegments.length} footer)`);
    }

    // ── Step 5: Locate the essence container start + any in-partition index ───
    // KLV-walks the essence-bearing partition to the first Generic Container element, collecting
    // index table segments that live in that partition's pre-essence (index) region — which the
    // header-metadata scan above misses (it only covers headerByteCount bytes, and some encoders,
    // e.g. XAVC, place a CBG index segment in the index region that follows).
    const { essenceStart, bodySID: essenceBodySID, indexSegments: essencePartitionIndex } =
      await this.locateEssence(ripEntries, headerPartition, afterPP + metaSize, fileSize);
    for (const seg of essencePartitionIndex) {
      const dup = indexSegments.some(s =>
        s.bodySID === seg.bodySID && s.indexSID === seg.indexSID &&
        s.indexStartPosition === seg.indexStartPosition &&
        s.editUnitByteCount === seg.editUnitByteCount &&
        s.entries.length === seg.entries.length);
      if (!dup) indexSegments.push(seg);
    }
    if (this.debug) console.log(`[jsmxf] essenceStart=${essenceStart}, essenceBodySID=${essenceBodySID}, +${essencePartitionIndex.length} in-partition index segs`);

    // ── Step 6: Determine the seeking strategy ────────────────────────────────
    const indexMode: IndexMode = classifyIndexMode(indexSegments, essenceBodySID);
    if (this.debug) console.log(`[jsmxf] indexMode=${indexMode}`);

    this.bootstrap = { headerPartition, metadata, indexSegments, ripEntries, essenceStart, essenceBodySID, indexMode };
    return this.bootstrap;
  }

  // ---------------------------------------------------------------------------

  private findHeaderMetadata(
    metaBuf: ArrayBuffer
  ): { primer: PrimerPack; metadataStart: number; metadataLength: number } {
    // metaBuf starts immediately after the partition pack.
    // It contains: Primer Pack | metadata Sets | (optional fill / index embedded)
    const iter = new KLVIterator(metaBuf, 0);
    let primer: PrimerPack = new Map();
    let metadataStart = 0;

    while (iter.hasMore()) {
      const pkt = iter.next();
      if (!pkt) break;

      // Stop if we accidentally hit another partition pack
      if (isPrimerPack(pkt.key)) {
        primer = parsePrimerPack(metaBuf, pkt);
        metadataStart = iter.offset; // metadata sets begin right after the primer
        continue;
      }

      if (isFill(pkt.key)) continue;

      // Stop if we hit another partition pack (Primer Pack already handled above)
      if (isPartitionPack(pkt.key)) {
        return { primer, metadataStart, metadataLength: pkt.valueOffset - 16 - metadataStart };
      }

      // First non-primer, non-fill KLV: we've found the start of metadata sets.
      // Break and let parseHeaderMetadata walk the rest.
      break;
    }

    return { primer, metadataStart, metadataLength: metaBuf.byteLength - metadataStart };
  }

  private parseRandomIndexPack(tailBuf: ArrayBuffer): RandomIndexPackEntry[] {
    const u8 = new Uint8Array(tailBuf);

    // Scan backwards for a KLV key starting with 06 0E 2B 34
    let searchPos = tailBuf.byteLength - 16;
    while (searchPos >= 0) {
      if (u8[searchPos] === 0x06 && u8[searchPos+1] === 0x0e &&
          u8[searchPos+2] === 0x2b && u8[searchPos+3] === 0x34) {
        try {
          const klv = readKLV(tailBuf, searchPos);
          if (ulEquals(klv.key, UL_RANDOM_INDEX_PACK)) {
            return this.decodeRIP(tailBuf, klv.valueOffset, klv.valueLength);
          }
        } catch {
          // not a valid KLV at this position — keep searching
        }
      }
      searchPos--;
    }
    return [];
  }

  private decodeRIP(buf: ArrayBuffer, offset: number, length: number): RandomIndexPackEntry[] {
    const v = new DataView(buf);
    const entries: RandomIndexPackEntry[] = [];
    // RIP value: N × (4-byte BodySID + 8-byte partition byte offset) + 4-byte total length
    const entryCount = Math.floor((length - 4) / 12);
    for (let i = 0; i < entryCount; i++) {
      const base = offset + i * 12;
      const bodySID = v.getUint32(base, false);
      const hiOff = v.getInt32(base + 4, false);
      const loOff = v.getUint32(base + 8, false);
      entries.push({ bodySID, byteOffset: (BigInt(hiOff) << 32n) | BigInt(loOff) });
    }
    return entries;
  }

  private findFooterOffset(rip: RandomIndexPackEntry[], header: PartitionPack): bigint {
    // Footer partition has bodySID == 0 and is not the header partition itself
    const footer = rip.find(e => e.bodySID === 0 && e.byteOffset !== header.thisPartition);
    return footer?.byteOffset ?? header.footerPartition;
  }

  /**
   * Locate the essence container start by KLV-walking the essence-bearing partition. Returns the
   * byte offset of the first Generic Container content-package element (the point index streamOffset
   * 0 / CBG frame 0 is measured from), the partition's BodySID, and any Index Table Segments found
   * in the partition's pre-essence region.
   *
   * Why walk rather than trust byte counts: some encoders (e.g. XAVC) understate headerByteCount and
   * tuck a CBG index segment into the index region between metadata and essence, so neither
   * "skip headerByteCount+indexByteCount" nor "first non-fill KLV after the partition pack" lands
   * correctly. Walking whole KLVs and stopping at the first 0D 01 03 01 element is robust to both
   * essence-in-header-partition (XAVC) and essence-in-body-partition (D-10/OP1a) layouts.
   */
  private async locateEssence(
    rip: RandomIndexPackEntry[],
    _header: PartitionPack,
    fallback: number,
    fileSize: number
  ): Promise<{ essenceStart: bigint; bodySID: number; indexSegments: IndexTableSegment[] }> {
    const body = rip.find(e => e.bodySID > 0);
    const partOffset = Number(body?.byteOffset ?? BigInt(fallback));
    const indexSegments: IndexTableSegment[] = [];

    // Essence usually begins within a few hundred KB of its partition pack (metadata + index +
    // fill). A 1 MB window covers every real-world case; if it doesn't, fall back to the partition
    // offset itself (sequential reading still works, just without the index).
    const window = Math.min(1024 * 1024, fileSize - partOffset);
    if (window <= 0) return { essenceStart: BigInt(partOffset), bodySID: 0, indexSegments };

    try {
      const buf = await this.loader.fetchRange(partOffset, partOffset + window - 1, 'bootstrap: essence partition scan');

      // Parse + skip the partition pack at the window start (best-effort: a fallback offset that
      // isn't a partition pack just means we walk from the window start with bodySID unknown).
      let bodySID = 0;
      let walkStart = 0;
      try {
        const ppStart = KLVIterator.skipRunIn(buf);
        bodySID = parsePartitionPack(buf, partOffset).bodySID;
        walkStart = ppStart + readKLV(buf, ppStart).totalLength;
      } catch { walkStart = 0; }

      const iter = new KLVIterator(buf, walkStart);
      while (iter.hasMore()) {
        const off = iter.offset;
        const pkt = iter.next();
        if (!pkt) break; // incomplete KLV at window end — essence lies beyond it
        if (isIndexTableSegment(pkt.key)) {
          try { indexSegments.push(parseIndexTableSegment(buf, pkt)); } catch { /* skip malformed */ }
          continue;
        }
        // First content-package element (system / picture / sound / data / D-10) → essence start.
        if (isGenericContainerElement(pkt.key)) {
          return { essenceStart: BigInt(partOffset + off), bodySID, indexSegments };
        }
        // Primer / fill / header metadata / partition packs are skipped by KLV length.
      }
      return { essenceStart: BigInt(partOffset), bodySID, indexSegments };
    } catch {
      return { essenceStart: BigInt(partOffset), bodySID: 0, indexSegments };
    }
  }

  private scanBufferForIndexSegments(buffer: ArrayBuffer, startOffset: number): IndexTableSegment[] {
    const segments: IndexTableSegment[] = [];
    const iter = new KLVIterator(buffer, startOffset);
    while (iter.hasMore()) {
      const pkt = iter.next();
      if (!pkt) break;
      if (isIndexTableSegment(pkt.key)) {
        try {
          segments.push(parseIndexTableSegment(buffer, pkt));
        } catch { /* skip malformed segment */ }
      }
    }
    return segments;
  }

  private async fetchIndexSegments(footerOffset: bigint, fileSize: number): Promise<IndexTableSegment[]> {
    const footerStart = Number(footerOffset);
    if (footerStart <= 0 || footerStart >= fileSize) return [];

    const footerBuf = await this.loader.fetchRange(footerStart, fileSize - 1, 'bootstrap: footer index table');

    // Skip the footer partition pack, then scan for index table segments
    const fpKlvOffset = KLVIterator.skipRunIn(footerBuf);
    let parseStart = fpKlvOffset;
    try {
      const fpKlv = readKLV(footerBuf, fpKlvOffset);
      if (isPartitionPack(fpKlv.key)) {
        parseStart = fpKlvOffset + fpKlv.totalLength;
      }
    } catch {
      // can't parse partition pack; scan from start
    }

    return this.scanBufferForIndexSegments(footerBuf, parseStart);
  }

  getBootstrap(): MxfBootstrap | null {
    return this.bootstrap;
  }
}
