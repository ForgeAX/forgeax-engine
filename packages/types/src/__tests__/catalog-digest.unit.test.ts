import { describe, expect, it } from 'vitest';
import { catalogDeltaDigest } from '../catalog.js';

describe('Catalog delta digest', () => {
  it('is stable for key order and changes for semantic rows', () => {
    const first = catalogDeltaDigest({
      added: [
        {
          guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
          packageUrl: '/packs/hero.pack.json',
          kind: 'texture',
          sourcePath: 'hero.png',
        },
      ],
      changed: [],
      removed: [],
    });
    const changed = catalogDeltaDigest({
      added: [],
      changed: [],
      removed: ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
    });
    expect(first).toMatch(/^sha256:/);
    expect(changed).not.toBe(first);
    expect(
      catalogDeltaDigest({
        removed: [],
        changed: [],
        added: [
          {
            sourcePath: 'hero.png',
            kind: 'texture',
            packageUrl: '/packs/hero.pack.json',
            guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
          },
        ],
      }),
    ).toBe(first);
  });
});
