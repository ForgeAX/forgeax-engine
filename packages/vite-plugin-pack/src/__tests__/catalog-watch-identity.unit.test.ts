import { calculateCatalogDelta } from '@forgeax/engine-pack/build';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const guid = (suffix: string): string => `019e2cc6-0c86-79da-aa76-b0984c86d${suffix}`;

const row = (
  id: string,
  options: Partial<Pick<PackIndexEntry, 'packageId' | 'sourceKey' | 'sourceIndex'>> = {},
): PackIndexEntry => ({
  guid: guid(id),
  kind: 'host/blob',
  packageUrl: `/assets/${id}.bin`,
  sourcePath: `${id}.source`,
  ...options,
});

describe('catalog watch identity boundaries', () => {
  it('reports missing keys as ambiguous for source-index-only multi-output reorder', () => {
    const delta = calculateCatalogDelta(
      [
        row('a', { packageId: 'pkg/ambiguous', sourceIndex: 0 }),
        row('b', { packageId: 'pkg/ambiguous', sourceIndex: 1 }),
      ],
      [
        row('b', { packageId: 'pkg/ambiguous', sourceIndex: 0 }),
        row('a', { packageId: 'pkg/ambiguous', sourceIndex: 1 }),
      ],
    );

    expect(delta?.topology).toHaveLength(1);
    expect(delta?.topology?.[0]?.preserved).toEqual([]);
    expect(delta?.topology?.[0]?.ambiguous).toMatchObject([
      { reason: 'source-index-ambiguous', previous: expect.any(Array), next: expect.any(Array) },
    ]);
  });

  it('reports duplicate producer keys instead of choosing the first row', () => {
    const delta = calculateCatalogDelta(
      [row('a', { packageId: 'pkg/duplicate', sourceKey: 'output/main', sourceIndex: 0 })],
      [
        row('a', { packageId: 'pkg/duplicate', sourceKey: 'output/main', sourceIndex: 0 }),
        row('b', { packageId: 'pkg/duplicate', sourceKey: 'output/main', sourceIndex: 1 }),
      ],
    );

    expect(delta?.topology?.[0]?.ambiguous).toMatchObject([
      { reason: 'duplicate-source-key', sourceKey: 'output/main' },
    ]);
    expect(delta?.topology?.[0]?.preserved).toEqual([]);
  });

  it('does not use a moved locator as identity when packageId is absent', () => {
    const previous = row('a', { sourceKey: 'output/main', sourceIndex: 0 });
    const next = {
      ...row('a', { sourceKey: 'output/main', sourceIndex: 0 }),
      sourcePath: 'moved.source',
    };

    const delta = calculateCatalogDelta([previous], [next]);

    expect(delta?.changed).toEqual([next]);
    expect(delta?.topology).toBeUndefined();
  });

  it('returns no delta for an empty catalog on both sides', () => {
    expect(calculateCatalogDelta([], [])).toBeUndefined();
  });
});
