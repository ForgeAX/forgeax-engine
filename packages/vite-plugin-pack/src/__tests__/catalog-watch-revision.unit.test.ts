import { calculateCatalogDelta } from '@forgeax/engine-pack/build';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const previous: PackIndexEntry[] = [
  {
    guid: '018e7a4d-1234-7abc-8def-000000000020',
    kind: 'host/blob',
    packageUrl: '/assets/old.bin',
    sourcePath: 'old.source',
  },
];

const next: PackIndexEntry[] = [
  {
    guid: '018e7a4d-1234-7abc-8def-000000000020',
    kind: 'host/blob',
    packageUrl: '/assets/new.bin',
    sourcePath: 'new.source',
  },
];

describe('catalog watch revision continuity', () => {
  it('rejects an out-of-order revision as stale', () => {
    const delta = calculateCatalogDelta(previous, next, {
      baseline: [{ rootId: 'root-a', revision: 3 }],
      current: [{ rootId: 'root-a', revision: 2 }],
    });

    expect(delta?.authority).toBe('degraded');
    expect(delta?.diagnostics).toMatchObject([
      { code: 'catalog-revision-stale', severity: 'blocking', hint: expect.any(String) },
    ]);
  });

  it('rejects a non-contiguous revision instead of overwriting the verified baseline', () => {
    const delta = calculateCatalogDelta(previous, next, {
      baseline: [{ rootId: 'root-a', revision: 1 }],
      current: [{ rootId: 'root-a', revision: 3 }],
    });

    expect(delta?.authority).toBe('degraded');
    expect(delta?.diagnostics?.[0]).toMatchObject({
      code: 'catalog-revision-conflict',
      expected: 'the next revision must be exactly baseline + 1',
      actual: '1 -> 3',
    });
  });

  it('rejects a current root without a verified baseline', () => {
    const delta = calculateCatalogDelta(previous, next, {
      baseline: [{ rootId: 'root-a', revision: 1 }],
      current: [
        { rootId: 'root-a', revision: 2 },
        { rootId: 'root-b', revision: 1 },
      ],
    });

    expect(delta?.authority).toBe('degraded');
    expect(delta?.diagnostics?.[0]).toMatchObject({
      code: 'catalog-revision-conflict',
      subject: { type: 'package', id: 'root-b' },
      hint: expect.any(String),
    });
  });

  it('rejects concurrent updates that reuse a revision with different rows', () => {
    const delta = calculateCatalogDelta(previous, next, {
      baseline: [{ rootId: 'root-a', revision: 2 }],
      current: [{ rootId: 'root-a', revision: 2 }],
    });

    expect(delta?.authority).toBe('degraded');
    expect(delta?.diagnostics?.[0]).toMatchObject({
      code: 'catalog-revision-conflict',
      actual: '2 -> 2',
    });
  });

  it('marks a contiguous changed revision authoritative', () => {
    const delta = calculateCatalogDelta(previous, next, {
      baseline: [{ rootId: 'root-a', revision: 1 }],
      current: [{ rootId: 'root-a', revision: 2 }],
    });

    expect(delta?.authority).toBe('authoritative');
    expect(delta?.diagnostics).toEqual([]);
    expect(delta?.revisions?.current).toEqual([{ rootId: 'root-a', revision: 2 }]);
    expect(delta?.changed).toEqual(next);
  });
});
