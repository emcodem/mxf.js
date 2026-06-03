import { DataViewReader } from '../core/data-view-reader.js';
import { KLVIterator, readKLV } from '../core/klv.js';
import { isPartitionPack } from '../core/ul.js';

export type PartitionKind = 'header' | 'body' | 'footer';

export interface PartitionPack {
  kind: PartitionKind;
  /** 0=closed/complete, 1=open/incomplete */
  status: number;
  majorVersion: number;
  minorVersion: number;
  kagSize: number;
  thisPartition: bigint;
  previousPartition: bigint;
  footerPartition: bigint;
  headerByteCount: bigint;
  indexByteCount: bigint;
  indexSID: number;
  bodyOffset: bigint;
  bodySID: number;
  operationalPattern: Uint8Array;
  essenceContainers: Uint8Array[];
  /** Absolute byte offset of this partition pack within the file */
  fileOffset: number;
}

export function parsePartitionPack(buffer: ArrayBuffer, bufferFileOffset: number): PartitionPack {
  const startOffset = KLVIterator.skipRunIn(buffer);
  const klv = readKLV(buffer, startOffset);

  if (!isPartitionPack(klv.key)) {
    throw new Error(`Expected Partition Pack key at offset ${bufferFileOffset + startOffset}`);
  }

  // Byte 13 of the 16-byte key encodes partition type:
  // 0x01 = Header Open, 0x02 = Header Closed, 0x03 = Body Open, 0x04 = Body Closed,
  // 0x05 = Footer Open, 0x06 = Footer Closed
  const typeByte = klv.key[13];
  let kind: PartitionKind;
  if (typeByte <= 0x02) kind = 'header';
  else if (typeByte <= 0x04) kind = 'body';
  else kind = 'footer';

  const r = new DataViewReader(buffer, klv.valueOffset);

  const majorVersion = r.readU16BE();
  const minorVersion = r.readU16BE();
  const kagSize = r.readU32BE();
  const thisPartition = r.readU64BE();
  const previousPartition = r.readU64BE();
  const footerPartition = r.readU64BE();
  const headerByteCount = r.readU64BE();
  const indexByteCount = r.readU64BE();
  const indexSID = r.readU32BE();
  const bodyOffset = r.readU64BE();
  const bodySID = r.readU32BE();
  const operationalPattern = r.readBytesCopy(16);

  // Essence containers: batch array (4-byte count, 4-byte item length, then N*16 byte ULs).
  // Bounded against the KLV value length: a corrupt count/itemLen must not loop into the next
  // packet or spin allocating (an itemLen of 0 would otherwise iterate `ecCount` times for nothing).
  const ecCount = r.readU32BE();
  const ecItemLen = r.readU32BE();
  const ecValueEnd = klv.valueOffset + klv.valueLength;
  const essenceContainers: Uint8Array[] = [];
  if (ecItemLen > 0) {
    for (let i = 0; i < ecCount && r.offset + ecItemLen <= ecValueEnd; i++) {
      essenceContainers.push(r.readBytesCopy(ecItemLen));
    }
  }

  return {
    kind,
    status: typeByte % 2 === 1 ? 1 : 0, // odd = open, even = closed
    majorVersion,
    minorVersion,
    kagSize,
    thisPartition,
    previousPartition,
    footerPartition,
    headerByteCount,
    indexByteCount,
    indexSID,
    bodyOffset,
    bodySID,
    operationalPattern,
    essenceContainers,
    fileOffset: bufferFileOffset + startOffset,
  };
}

/** Returns the byte offset immediately after the partition pack KLV */
export function partitionPackEndOffset(buffer: ArrayBuffer, startOffset: number): number {
  const klv = readKLV(buffer, startOffset);
  return startOffset + klv.totalLength;
}
