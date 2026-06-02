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
import {
  PARTITION_PACK_READ_SIZE,
  TAIL_READ_SIZE,
  FOOTER_READ_MAX,
  HEADER_METADATA_MIN_READ,
  HEADER_METADATA_FALLBACK_READ,
  ESSENCE_SCAN_WINDOW,
} from './core/constants.js';

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
    const ppBuf = await this.loader.fetchRange(0, Math.min(PARTITION_PACK_READ_SIZE, fileSize) - 1, 'bootstrap: header partition pack');
    const ppStartOffset = KLVIterator.skipRunIn(ppBuf);
    const headerPartition = parsePartitionPack(ppBuf, 0);
    const ppKlv = readKLV(ppBuf, ppStartOffset);
    const afterPP = ppStartOffset + ppKlv.totalLength; // file offset of first metadata KLV

    // ── Step 2: Fetch the full header metadata section ────────────────────────
    // headerByteCount = Primer Pack + all metadata Sets (exact byte count from spec).
    // This avoids the problem of hitting large essence KLVs that follow the metadata.
    const metaSize = Number(headerPartition.headerByteCount);
    // Read generously. Some encoders (XAVC, D-10) understate headerByteCount so it doesn't cover all
    // metadata sets — the sound descriptor in particular can sit past it, which previously made the
    // file look like it had no audio. Read at least a comfortable window (or 2 MB when the count is
    // absent) and rely on parseHeaderMetadata stopping at the first non-metadata KLV.
    const wantBytes = metaSize > 0 ? Math.max(metaSize, HEADER_METADATA_MIN_READ) : HEADER_METADATA_FALLBACK_READ;
    const readSize = Math.min(wantBytes, fileSize - afterPP);
    const metaBuf = await this.loader.fetchRange(afterPP, afterPP + readSize - 1, 'bootstrap: header metadata');

    const { primer, metadataStart, metadataLength } = this.findHeaderMetadata(metaBuf);
    if (this.debug) {
      console.log(`[mxf.js] headerByteCount=${metaSize}, metaBuf.length=${metaBuf.byteLength}, metadataStart=${metadataStart}, metadataLength=${metadataLength}`);
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
    const footerStart = Number(footerOffset);
    // If the footer lies within the tail buffer already fetched, reuse it — this avoids a second
    // network seek to the end of a large file (e.g. 30 GB on SMB), which can cost several seconds.
    const footerIndexSegments = (footerStart > 0 && footerStart >= tailStart)
      ? this.parseFooterIndexSegments(tailBuf.slice(footerStart - tailStart))
      : await this.fetchIndexSegments(footerOffset, fileSize);
    const indexSegments = [...headerIndexSegments, ...footerIndexSegments];
    if (this.debug && indexSegments.length > 0) {
      console.log(`[mxf.js] indexSegments: ${indexSegments.length} (${headerIndexSegments.length} header, ${footerIndexSegments.length} footer)`);
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
    if (this.debug) console.log(`[mxf.js] essenceStart=${essenceStart}, essenceBodySID=${essenceBodySID}, +${essencePartitionIndex.length} in-partition index segs`);

    // ── Step 5b: Multi-partition VBE index (XDCAM-style OP1a) ──────────────────
    // VBE index entry streamOffsets are essence-CONTAINER-relative — they count only essence bytes,
    // excluding the partition packs / index / fill interleaved between body partitions — so
    // `essenceStart + streamOffset` only lands correctly within the first body partition. Whenever
    // the essence spans body partitions, walk them (via the RIP) to build a {bodyOffset →
    // essenceFileStart} table and remap every VBE entry's streamOffset to a file offset. This is
    // needed even when the footer index already covers frame 0 (the offsets are still container-
    // relative). Skipped for CBG (offset is pure math) and when there's no usable RIP (growing/live
    // files fall through to indexMode 'none' + percentage seeking).
    const hasCbg = indexSegments.some(s => s.editUnitByteCount > 0);
    const hasVbeEntries = indexSegments.some(s => s.entries.length > 0);
    if (!hasCbg && hasVbeEntries && ripEntries.some(e => e.bodySID > 0)) {
      const { partitions, segments } = await this.collectMultiPartitionIndex(ripEntries, fileSize);
      if (partitions.length > 0) {
        for (const seg of segments) {
          const dup = indexSegments.some(s =>
            s.bodySID === seg.bodySID && s.indexSID === seg.indexSID &&
            s.indexStartPosition === seg.indexStartPosition && s.entries.length === seg.entries.length);
          if (!dup) indexSegments.push(seg);
        }
        // For a stream offset SO, find the body partition whose essence it falls in (largest
        // bodyOffset ≤ SO) and map: fileOffset = partition.essenceFileStart + (SO − bodyOffset).
        // Expressed relative to essenceStart so the resolver's `essenceStart + streamOffset` is
        // unchanged. Single-partition files yield an identity remap (bodyOffset 0, essenceFileStart
        // === essenceStart), so this is safe to always apply to multi-segment VBE files.
        const es = Number(essenceStart);
        const mapStreamOffset = (so: number): number => {
          let p = partitions[0];
          for (const q of partitions) { if (q.bodyOffset <= so) p = q; else break; }
          return p.essenceFileStart + (so - p.bodyOffset) - es;
        };
        for (const seg of indexSegments) {
          if (seg.editUnitByteCount > 0) continue; // CBG has no entry array
          for (const e of seg.entries) e.streamOffset = BigInt(mapStreamOffset(Number(e.streamOffset)));
        }
        if (this.debug) console.log(`[mxf.js] multi-partition VBE index: ${partitions.length} partitions, ${indexSegments.length} segs (remapped)`);
      }
    }

    // ── Step 6: Determine the seeking strategy ────────────────────────────────
    const indexMode: IndexMode = classifyIndexMode(indexSegments, essenceBodySID);
    if (this.debug) console.log(`[mxf.js] indexMode=${indexMode}`);

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
    const window = Math.min(ESSENCE_SCAN_WINDOW, fileSize - partOffset);
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

  /**
   * For OP1a files with incremental per-partition indexing (e.g. XDCAM HD422), build what's needed
   * to resolve VBE frame offsets across body partitions. Index entry `streamOffset`s are essence-
   * container-relative — they count only essence bytes, excluding the partition packs / index / fill
   * interleaved between body partitions — so `essenceStart + streamOffset` lands on the wrong byte
   * once past the first partition. Walk each RIP body partition to record its essence-stream offset
   * (`bodyOffset`, from the partition pack) and the file offset of its first essence element, then
   * the caller remaps every index entry's `streamOffset` to a file offset via this table.
   *
   * Bounded: one ~256 KB read per body partition.
   */
  private async collectMultiPartitionIndex(
    rip: RandomIndexPackEntry[],
    fileSize: number
  ): Promise<{ partitions: { bodyOffset: number; essenceFileStart: number }[]; segments: IndexTableSegment[] }> {
    const MAX_SCANS = 4096;
    const WINDOW = 64 * 1024; // PP + index region + first essence element fit comfortably
    const partitions: { bodyOffset: number; essenceFileStart: number }[] = [];
    const segments: IndexTableSegment[] = [];
    let scans = 0;

    for (const entry of rip) {
      if (entry.bodySID === 0) continue;          // body partitions only
      if (scans++ >= MAX_SCANS) break;
      const partOffset = Number(entry.byteOffset);
      if (partOffset <= 0 || partOffset >= fileSize) continue;

      try {
        const buf = await this.loader.fetchRange(
          partOffset, Math.min(partOffset + WINDOW, fileSize) - 1, 'bootstrap: body partition + index');
        const ppStart = KLVIterator.skipRunIn(buf);
        const pp = parsePartitionPack(buf, partOffset);
        const afterPP = ppStart + readKLV(buf, ppStart).totalLength;

        // Walk: collect any index segments, then stop at the first essence element (its file offset
        // is this partition's essence start, the anchor for bodyOffset). peekKey() avoids readKLV
        // choking on the large essence value that won't fit in the window.
        let essenceFileStart = -1;
        const iter = new KLVIterator(buf, afterPP);
        while (iter.hasMore()) {
          const key = iter.peekKey();
          if (!key) break;
          if (isGenericContainerElement(key)) { essenceFileStart = partOffset + iter.offset; break; }
          const pkt = iter.next();
          if (!pkt) break;
          if (isIndexTableSegment(pkt.key)) {
            try { segments.push(parseIndexTableSegment(buf, pkt)); } catch { /* skip malformed */ }
          }
        }
        if (essenceFileStart < 0) continue; // couldn't locate essence in this partition — skip it
        partitions.push({ bodyOffset: Number(pp.bodyOffset), essenceFileStart });
      } catch { /* skip this partition */ }
    }

    partitions.sort((a, b) => a.bodyOffset - b.bodyOffset);
    return { partitions, segments };
  }

  private parseFooterIndexSegments(footerBuf: ArrayBuffer): IndexTableSegment[] {
    const fpKlvOffset = KLVIterator.skipRunIn(footerBuf);
    let parseStart = fpKlvOffset;
    try {
      const fpKlv = readKLV(footerBuf, fpKlvOffset);
      if (isPartitionPack(fpKlv.key)) parseStart = fpKlvOffset + fpKlv.totalLength;
    } catch { /* scan from start */ }
    return this.scanBufferForIndexSegments(footerBuf, parseStart);
  }

  private async fetchIndexSegments(footerOffset: bigint, fileSize: number): Promise<IndexTableSegment[]> {
    const footerStart = Number(footerOffset);
    if (footerStart <= 0 || footerStart >= fileSize) return [];
    // Cap the read: never fetch more than FOOTER_READ_MAX bytes regardless of what footerPartition
    // says (a wrong/small footerPartition offset would otherwise read almost the entire file).
    const readEnd = Math.min(fileSize - 1, footerStart + FOOTER_READ_MAX - 1);
    const footerBuf = await this.loader.fetchRange(footerStart, readEnd, 'bootstrap: footer index table');
    return this.parseFooterIndexSegments(footerBuf);
  }

  getBootstrap(): MxfBootstrap | null {
    return this.bootstrap;
  }
}
