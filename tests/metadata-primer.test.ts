import { describe, it, expect } from 'vitest';
import { remapDynamicTags } from '../src/parser/metadata.js';
import type { PrimerPack } from '../src/parser/primer.js';

// A made-up item UL and a dynamic local tag (0x8000+) the Primer maps to it.
const ITEM_UL = new Uint8Array([0x06, 0x0e, 0x2b, 0x34, 0x01, 0x01, 0x01, 0x02, 0x04, 0x01, 0x05, 0x02, 0x02, 0x00, 0x00, 0x00]);
const CANONICAL_TAG = 0x3203; // e.g. StoredWidth
const DYNAMIC_TAG = 0x8001;

describe('remapDynamicTags (Primer-based dynamic local-tag resolution)', () => {
  it('aliases a dynamic tag to the canonical tag via the Primer UL', () => {
    const primer: PrimerPack = new Map([[DYNAMIC_TAG, ITEM_UL]]);
    const items = new Map<number, Uint8Array>([[DYNAMIC_TAG, new Uint8Array([0, 0, 7, 0x80])]]);
    remapDynamicTags(items, primer, [{ ul: ITEM_UL, tag: CANONICAL_TAG }]);
    expect(items.has(CANONICAL_TAG)).toBe(true);
    expect(Array.from(items.get(CANONICAL_TAG)!)).toEqual([0, 0, 7, 0x80]);
  });

  it('does not overwrite a canonical tag that is already present', () => {
    const primer: PrimerPack = new Map([[DYNAMIC_TAG, ITEM_UL]]);
    const original = new Uint8Array([1, 1, 1, 1]);
    const items = new Map<number, Uint8Array>([
      [CANONICAL_TAG, original],
      [DYNAMIC_TAG, new Uint8Array([2, 2, 2, 2])],
    ]);
    remapDynamicTags(items, primer, [{ ul: ITEM_UL, tag: CANONICAL_TAG }]);
    expect(items.get(CANONICAL_TAG)).toBe(original); // unchanged
  });

  it('is a no-op when there are no aliases or an empty primer', () => {
    const items = new Map<number, Uint8Array>([[0x8001, new Uint8Array([9])]]);
    remapDynamicTags(items, new Map(), [{ ul: ITEM_UL, tag: CANONICAL_TAG }]); // empty primer
    expect(items.has(CANONICAL_TAG)).toBe(false);
    remapDynamicTags(items, new Map([[0x8001, ITEM_UL]]), []); // no aliases
    expect(items.has(CANONICAL_TAG)).toBe(false);
  });
});
