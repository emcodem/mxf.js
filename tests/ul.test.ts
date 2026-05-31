import { describe, it, expect } from 'vitest';
import {
  ulEquals, ulStartsWith, isPartitionPack, isEssenceElement, isPictureEssence,
  isSoundEssence, isIndexTableSegment, isFill, isGenericContainerElement,
  UL_PRIMER_PACK, UL_RANDOM_INDEX_PACK, UL_INDEX_TABLE_SEGMENT_V1,
  UL_GC_PICTURE_ITEM_PREFIX, UL_GC_SOUND_ITEM_PREFIX, UL_KLV_FILL,
  UL_PARTITION_PACK_PREFIX, UL_HEADER_PARTITION_CLOSED, UL_HEADER_PARTITION_OPEN,
} from '../src/core/ul.js';

describe('ulEquals', () => {
  it('returns true for identical arrays', () => {
    const a = new Uint8Array([1,2,3]);
    expect(ulEquals(a, a.slice())).toBe(true);
  });
  it('returns false for different arrays', () => {
    expect(ulEquals(new Uint8Array([1,2]), new Uint8Array([1,3]))).toBe(false);
  });
  it('returns false for different lengths', () => {
    expect(ulEquals(new Uint8Array([1,2,3]), new Uint8Array([1,2]))).toBe(false);
  });
});

describe('ulStartsWith', () => {
  it('returns true when key starts with prefix', () => {
    const key = new Uint8Array([0x06, 0x0e, 0x2b, 0x34, 0x99, 0x88]);
    const prefix = new Uint8Array([0x06, 0x0e, 0x2b, 0x34]);
    expect(ulStartsWith(key, prefix)).toBe(true);
  });
  it('returns false when key shorter than prefix', () => {
    expect(ulStartsWith(new Uint8Array([1,2]), new Uint8Array([1,2,3]))).toBe(false);
  });
});

describe('isPartitionPack', () => {
  it('recognises a header partition pack key', () => {
    expect(isPartitionPack(UL_HEADER_PARTITION_CLOSED)).toBe(true);
  });
  it('rejects a non-partition key', () => {
    expect(isPartitionPack(UL_PRIMER_PACK)).toBe(false);
  });
});

describe('isEssenceElement', () => {
  it('recognises picture essence element', () => {
    const key = new Uint8Array(16);
    key.set(UL_GC_PICTURE_ITEM_PREFIX);
    expect(isEssenceElement(key)).toBe(true);
    expect(isPictureEssence(key)).toBe(true);
    expect(isSoundEssence(key)).toBe(false);
  });
  it('recognises sound essence element', () => {
    const key = new Uint8Array(16);
    key.set(UL_GC_SOUND_ITEM_PREFIX);
    expect(isEssenceElement(key)).toBe(true);
    expect(isSoundEssence(key)).toBe(true);
    expect(isPictureEssence(key)).toBe(false);
  });
});

describe('isIndexTableSegment', () => {
  it('recognises index table segment V1', () => {
    expect(isIndexTableSegment(UL_INDEX_TABLE_SEGMENT_V1)).toBe(true);
  });
  it('rejects random index pack', () => {
    expect(isIndexTableSegment(UL_RANDOM_INDEX_PACK)).toBe(false);
  });
});

describe('UL_RANDOM_INDEX_PACK', () => {
  // Regression: the constant previously dropped the byte-12 0x01, so the RIP (and the body-partition
  // offsets used to locate essence) was never found in conformant files. The correct SMPTE ST 377-1
  // key is 06 0E 2B 34 02 05 01 01 0D 01 02 01 01 11 01 00.
  it('matches the SMPTE RIP key', () => {
    expect(Array.from(UL_RANDOM_INDEX_PACK)).toEqual(
      [0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0d, 0x01, 0x02, 0x01, 0x01, 0x11, 0x01, 0x00],
    );
  });
});

describe('isGenericContainerElement', () => {
  const gc = (b12: number, b13 = 0x01, b14 = 0x01) =>
    new Uint8Array([0x06, 0x0e, 0x2b, 0x34, 0x01, 0x02, 0x01, 0x01, 0x0d, 0x01, 0x03, 0x01, b12, b13, b14, 0x00]);

  it('recognises system / picture / sound / data / D-10 content-package items', () => {
    expect(isGenericContainerElement(gc(0x04))).toBe(true); // system item
    expect(isGenericContainerElement(gc(0x15))).toBe(true); // GC picture
    expect(isGenericContainerElement(gc(0x16))).toBe(true); // GC sound
    expect(isGenericContainerElement(gc(0x17))).toBe(true); // GC data
    expect(isGenericContainerElement(gc(0x18))).toBe(true); // D-10
  });
  it('rejects header metadata, index, primer and partition packs', () => {
    expect(isGenericContainerElement(UL_GC_PICTURE_ITEM_PREFIX)).toBe(true);
    expect(isGenericContainerElement(UL_INDEX_TABLE_SEGMENT_V1)).toBe(false); // 0d 01 02 01
    expect(isGenericContainerElement(UL_PRIMER_PACK)).toBe(false);            // 0d 01 02 01
    expect(isGenericContainerElement(UL_HEADER_PARTITION_OPEN)).toBe(false);  // 0d 01 02 01
    expect(isGenericContainerElement(UL_KLV_FILL)).toBe(false);
    // Header metadata sets are 0d 01 01 01 …
    const metaSet = new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x23,0x00]);
    expect(isGenericContainerElement(metaSet)).toBe(false);
  });
});

describe('isFill', () => {
  it('recognises KLV fill item', () => {
    expect(isFill(UL_KLV_FILL)).toBe(true);
  });
  it('rejects non-fill', () => {
    expect(isFill(UL_PRIMER_PACK)).toBe(false);
  });
});
