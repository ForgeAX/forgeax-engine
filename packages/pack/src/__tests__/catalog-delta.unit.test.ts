import type { CatalogEntry } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { calculateCatalogDelta } from '../catalog-delta.js';
import { createRuntimePackPublication } from '../runtime-publication.js';

it('compares shared publication contents once per delta and observes later changes', () => {
  const { publication } = createRuntimePackPublication({
    pack: {
      assets: Array.from({ length: 64 }, (_, index) => ({
        guid: `mesh-${index}`,
        kind: 'mesh' as const,
        payload: { index },
        refs: [],
      })),
    },
    scopeId: 'delta',
    sourcePath: 'scene.pack.ts',
    sourceRevision: 'one',
    packageUrl: '/scene.pack.json',
  });
  const updated = structuredClone(publication);
  let reads = 0;
  const originalOutputs = publication.outputs;
  const observed = {
    ...publication,
    get outputs() {
      reads++;
      return originalOutputs;
    },
  };
  const rows = (envelope: typeof publication): CatalogEntry[] =>
    originalOutputs.map((output) => ({
      guid: output.guid,
      kind: output.kind,
      sourcePath: 'scene.pack.ts',
      packageUrl: '/scene.pack.json',
      publication: envelope,
    }));
  const before = rows(observed),
    after = rows(updated);
  expect(calculateCatalogDelta(before, after)).toBeUndefined();
  expect(reads).toBeLessThanOrEqual(2);
  // A claimed digest is not a substitute for comparing complete output facts,
  // and memoization must not survive an independent comparison.
  Object.assign(updated.outputs[0] ?? {}, { refs: ['changed-reference'] });
  expect(calculateCatalogDelta(before, after)?.changed).toEqual(after);
});

it('compares canonical POD fields independently of object key order and GUID case', () => {
  const left: CatalogEntry = {
    guid: 'ABC',
    kind: 'mesh',
    sourcePath: 'scene.pack.ts',
    packageUrl: '/scene',
  };
  const right: CatalogEntry = {
    packageUrl: '/scene',
    sourcePath: 'scene.pack.ts',
    kind: 'mesh',
    guid: 'abc',
  };
  expect(calculateCatalogDelta([left], [right])).toBeUndefined();
  expect(
    calculateCatalogDelta([left], [{ ...right, packageUrl: '/changed' }])?.changed,
  ).toHaveLength(1);
});
