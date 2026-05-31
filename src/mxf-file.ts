import { ILoader } from './loader/loader.js';
import { KLVIterator, readKLV } from './core/klv.js';
import { decodeBerLength } from './core/ber.js';
import { parsePartitionPack, PartitionPack } from './parser/partition.js';
import { parsePrimerPack, PrimerPack } from './parser/primer.js';
import { parseHeaderMetadata, MxfMetadata } from './parser/metadata.js';
import { parseIndexTableSegment, IndexTableSegment } from './parser/index-table.js';
import {
  isPartitionPack,
  isPrimerPack,
  isIndexTableSegment,
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

export interface MxfBootstrap {
  headerPartition: PartitionPack;
  metadata: MxfMetadata;
  indexSegments: IndexTableSegment[];
  ripEntries: RandomIndexPackEntry[];
  /** Absolute file offset where the first body partition pack starts */
  essenceStart: bigint;
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

    // ── Step 5: Locate first body partition ───────────────────────────────────
    const essenceStart = await this.findEssenceStart(ripEntries, headerPartition, afterPP + metaSize, fileSize);
    if (this.debug) console.log(`[jsmxf] essenceStart=${essenceStart}`);

    this.bootstrap = { headerPartition, metadata, indexSegments, ripEntries, essenceStart };
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

  private async findEssenceStart(
    rip: RandomIndexPackEntry[],
    _header: PartitionPack,
    fallback: number,
    fileSize: number
  ): Promise<bigint> {
    const body = rip.find(e => e.bodySID > 0);
    const bodyPPStart = body?.byteOffset ?? BigInt(fallback);

    // Skip over the body partition pack, then over any trailing fill/padding to reach
    // the first essence KLV.  StreamOffset values in the index are measured from that KLV.
    try {
      const ppBuf = await this.loader.fetchRange(Number(bodyPPStart), Math.min(Number(bodyPPStart) + 256, fileSize) - 1, 'bootstrap: body partition pack');
      const ppView = new DataView(ppBuf);
      const { length: ppValueLen, bytesRead: berBytes } = decodeBerLength(ppView, 16);
      const afterBodyPP = Number(bodyPPStart) + 16 + berBytes + ppValueLen;

      // Scan forward from afterBodyPP to find the first non-fill, non-zero KLV.
      // Some encoders write raw zero padding (sector alignment) rather than KLV fill,
      // so we search for the next 06 0E 2B 34 sync rather than relying on the fill key.
      const SCAN_WINDOW = Math.min(65536, fileSize - afterBodyPP);
      if (SCAN_WINDOW <= 0) return BigInt(afterBodyPP);

      const scanBuf = await this.loader.fetchRange(afterBodyPP, afterBodyPP + SCAN_WINDOW - 1, 'bootstrap: essence-start scan');
      const scanU8 = new Uint8Array(scanBuf);
      const scanDV = new DataView(scanBuf);
      let pos = 0;

      while (pos <= SCAN_WINDOW - 16) {
        // Find next 06 0E 2B 34 sync
        if (scanU8[pos] !== 0x06 || scanU8[pos+1] !== 0x0e ||
            scanU8[pos+2] !== 0x2b || scanU8[pos+3] !== 0x34) {
          pos++;
          continue;
        }
        // If it's KLV fill, jump over it and keep scanning
        const key16 = scanU8.subarray(pos, pos + 16);
        if (isFill(key16) && pos + 16 < SCAN_WINDOW) {
          try {
            const { length: fLen, bytesRead: fBer } = decodeBerLength(scanDV, pos + 16);
            pos += 16 + fBer + fLen;
            continue;
          } catch { break; }
        }
        // Non-fill KLV found — this is the start of the essence container
        return BigInt(afterBodyPP + pos);
      }

      return BigInt(afterBodyPP);
    } catch {
      return bodyPPStart;
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
