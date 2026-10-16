import { describe, expect, it } from 'vitest';
import { validateCatalogDelta } from '../catalog.js';

const row = {
  guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
  packageUrl: '/packs/hero.pack.json',
  kind: 'texture',
  sourcePath: 'hero.png',
};

describe('Catalog delta guard', () => {
  it('accepts a complete delta and rejects malformed identity arrays', () => {
    const valid = validateCatalogDelta({ added: [row], changed: [], removed: [] });
    expect(valid.ok).toBe(true);

    const malformed = validateCatalogDelta({ added: [row], changed: [], removed: [7] });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('catalog-delta-invalid');
  });
});
