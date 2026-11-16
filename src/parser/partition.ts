import { DataViewReader } from '../core/data-view-reader.js';
import { KLVIterator, readKLV } from '../core/klv.js';
import { isPartitionPack } from '../core/ul.js';

export type PartitionKind = 'header' | 'body' | 'footer';

export interface PartitionPack {
  kind: PartitionKind;
  /** 1 = open, 0 = closed (key byte 14). Completeness is reported separately in `complete`. */
  status: number;
  /** Header metadata is complete (key byte 14 = 03 or 04). */
  complete: boolean;
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

  // ST 377-1: byte 13 = type (02 header, 03 body, 04 footer; isPartitionPack() guarantees one of these),
  //           byte 14 = status (01 open/incomplete, 02 closed/incomplete, 03 open/complete, 04 closed/complete)
  const typeByte = klv.key[13];
  const statusByte = klv.key[14];
  const kind: PartitionKind = typeByte === 0x02 ? 'header' : typeByte === 0x03 ? 'body' : 'footer';

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
    status: statusByte === 0x01 || statusByte === 0x03 ? 1 : 0,
    complete: statusByte === 0x03 || statusByte === 0x04,
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
