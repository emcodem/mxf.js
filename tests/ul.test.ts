import { describe, it, expect } from 'vitest';
import {
  ulEquals, ulStartsWith, isPartitionPack, isEssenceElement, isPictureEssence,
  isSoundEssence, isIndexTableSegment, isFill,
  UL_PRIMER_PACK, UL_RANDOM_INDEX_PACK, UL_INDEX_TABLE_SEGMENT_V1,
  UL_GC_PICTURE_ITEM_PREFIX, UL_GC_SOUND_ITEM_PREFIX, UL_KLV_FILL,
  UL_PARTITION_PACK_PREFIX, UL_HEADER_PARTITION_CLOSED,
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

describe('isFill', () => {
  it('recognises KLV fill item', () => {
    expect(isFill(UL_KLV_FILL)).toBe(true);
  });
  it('rejects non-fill', () => {
    expect(isFill(UL_PRIMER_PACK)).toBe(false);
  });
});
