import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveInstancesUnionBounds, InstanceBoundsCache } from '../instances-derived-bounds';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function translated(x: number, y = 0, z = 0): Float32Array {
  const matrix = new Float32Array(IDENTITY);
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

const meshAabb = new Float32Array([-1, -1, -1, 1, 1, 1]);
const entityWorld = new Float32Array(IDENTITY);

describe('Instances renderer-derived union bounds', () => {
  it('unions every transformed mesh corner in entity world space', () => {
    expect(
      deriveInstancesUnionBounds({
        meshAabb,
        entityWorld,
        transforms: new Float32Array([...IDENTITY, ...translated(5, 2, -3)]),
      }),
    ).toEqual(new Float32Array([-1, -1, -4, 6, 3, 1]));
  });

  it('does not manufacture a visible bound for empty or malformed input', () => {
    expect(
      deriveInstancesUnionBounds({ meshAabb, entityWorld, transforms: new Float32Array() }),
    ).toBeUndefined();
    expect(
      deriveInstancesUnionBounds({
        meshAabb,
        entityWorld,
        transforms: new Float32Array([...IDENTITY, 1, 2]),
      }),
    ).toBeUndefined();
    expect(
      deriveInstancesUnionBounds({
        meshAabb,
        entityWorld,
        transforms: new Float32Array([...IDENTITY.slice(0, 15), Number.NaN]),
      }),
    ).toBeUndefined();
  });

  it('invalidates one cached projection when mesh, entity, or matrix generation changes', () => {
    const cache = new InstanceBoundsCache();
    const input = {
      entityKey: 7,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld,
      transforms: new Float32Array(IDENTITY),
    };
    const first = cache.get(input);
    expect(first).toEqual(meshAabb);
    expect(cache.get(input)).toBe(first);

    const matrixChanged = cache.get({ ...input, matrixGeneration: 2, transforms: translated(9) });
    expect(matrixChanged).not.toBe(first);
    expect(matrixChanged?.[0]).toBe(8);

    const entityChanged = cache.get({
      ...input,
      transformGeneration: 2,
      entityWorld: translated(10),
    });
    expect(entityChanged).not.toBe(first);
    expect(entityChanged?.[0]).toBe(9);

    const meshChanged = cache.get({
      ...input,
      meshGeneration: 2,
      meshAabb: new Float32Array([-2, -1, -1, 2, 1, 1]),
    });
    expect(meshChanged).not.toBe(first);
    expect(meshChanged).toEqual(new Float32Array([-2, -1, -1, 2, 1, 1]));

    const reused = cache.get({ ...input, meshGeneration: 3 });
    expect(reused).not.toBe(first);
  });

  it('does not alias equal entity keys from different worlds in one composite scene', () => {
    const cache = new InstanceBoundsCache();
    const first = cache.get({
      worldId: 1,
      entityKey: 7,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld,
      transforms: new Float32Array(IDENTITY),
    });
    const second = cache.get({
      worldId: 2,
      entityKey: 7,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld: translated(20),
      transforms: new Float32Array(IDENTITY),
    });
    expect(second).not.toBe(first);
    expect(second?.[0]).toBe(19);
  });

  it('keeps affine negative-scale and shear bounds conservative without per-corner allocations', () => {
    const entityWorld = new Float32Array([-2, 0, 0, 0, 0.5, 1.5, 0, 0, 0, 0, 0.75, 0, 3, -2, 4, 1]);
    const actual = deriveInstancesUnionBounds({
      meshAabb: new Float32Array([-1, -2, -0.5, 2, 1, 1]),
      entityWorld,
      transforms: IDENTITY,
    });
    expect(actual).toBeDefined();
    if (actual === undefined) return;
    // The transformed center is (1.75, -2.75, 4.1875) and the absolute
    // linear map gives the conservative extents (3.75, 2.25, 0.5625).
    expect(Array.from(actual, (value) => Number(value.toFixed(4)))).toEqual([
      -2, -5, 3.625, 5.5, -0.5, 4.75,
    ]);
  });

  it('returns conservative no-cull for a homogeneous w interval crossing zero', () => {
    const projective = new Float32Array(IDENTITY);
    projective[3] = 1;
    expect(
      deriveInstancesUnionBounds({ meshAabb, entityWorld, transforms: projective }),
    ).toBeUndefined();
  });

  it('does not classify a tiny projective term as affine for a large AABB', () => {
    const projective = new Float32Array(IDENTITY);
    projective[3] = 5e-8;
    expect(
      deriveInstancesUnionBounds({
        meshAabb: new Float32Array([-3e7, -1, -1, 3e7, 1, 1]),
        entityWorld,
        transforms: projective,
      }),
    ).toBeUndefined();
  });

  it('exposes cache hit/miss evidence for the renderer-owned projection', () => {
    const cache = new InstanceBoundsCache();
    const input = {
      entityKey: 9,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld,
      transforms: new Float32Array(IDENTITY),
    };
    cache.get(input);
    cache.get(input);
    cache.get({ ...input, matrixGeneration: 2, transforms: translated(1) });
    cache.invalidate(9);
    expect(cache.inspect()).toEqual({
      hits: 1,
      misses: 2,
      derives: 2,
      invalidations: 1,
      rowUpdates: 0,
      nodeVisits: 2,
    });
  });

  describe('collection row hierarchy', () => {
    function grid(count: number): Float32Array {
      const transforms = new Float32Array(count * 16);
      for (let row = 0; row < count; row += 1) {
        transforms.set(
          translated((row % 97) * 3, Math.floor(row / 97) * 2, (row * 7) % 11),
          row * 16,
        );
      }
      return transforms;
    }

    function collectionInput(
      transforms: Float32Array,
      revision: number,
      dirtyRows?: { start: number; end: number }[],
    ) {
      return {
        entityKey: 3,
        meshGeneration: 1,
        transformGeneration: 1,
        matrixGeneration: revision,
        meshAabb,
        entityWorld: translated(1, 2, 3),
        transforms,
        collectionId: 5,
        revision,
        ...(dirtyRows === undefined ? {} : { dirtyRows }),
      };
    }

    function expectSameBounds(
      actual: Float32Array | undefined,
      expected: Float32Array | undefined,
    ) {
      expect(actual === undefined).toBe(expected === undefined);
      if (actual === undefined || expected === undefined) return;
      expect(Array.from(actual, (value) => value + 0)).toEqual(
        Array.from(expected, (value) => value + 0),
      );
    }

    it('matches the linear fold after every dirty-row revision and touches only dirty chains', () => {
      const cache = new InstanceBoundsCache();
      const count = 4099;
      const transforms = grid(count);
      expectSameBounds(
        cache.get(collectionInput(transforms, 1)),
        deriveInstancesUnionBounds({ meshAabb, entityWorld: translated(1, 2, 3), transforms }),
      );
      const afterBuild = cache.inspect().nodeVisits;
      let seed = 17;
      for (let revision = 2; revision < 40; revision += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const row = seed % count;
        transforms.set(translated((seed % 1000) - 500, (seed % 37) - 200, seed % 5), row * 16);
        const dirtyRows = [{ start: row, end: row + 1 }];
        const before = cache.inspect().nodeVisits;
        expectSameBounds(
          cache.get(collectionInput(transforms, revision, dirtyRows)),
          deriveInstancesUnionBounds({ meshAabb, entityWorld: translated(1, 2, 3), transforms }),
        );
        // One row plus at most one 16-child refresh per hierarchy level.
        expect(cache.inspect().nodeVisits - before).toBeLessThanOrEqual(1 + 16 * 4);
      }
      expect(cache.inspect().rowUpdates).toBe(38);
      expect(cache.inspect().derives).toBe(1);
      expect(afterBuild).toBeGreaterThan(count);
    });

    it('reports old and new boxes of the moved rows for change consumers', () => {
      const cache = new InstanceBoundsCache();
      const transforms = grid(64);
      cache.get(collectionInput(transforms, 1));
      expect(cache.rowChange(3)).toBeUndefined();
      transforms.set(translated(500, 0, 0), 10 * 16);
      cache.get(collectionInput(transforms, 2, [{ start: 10, end: 11 }]));
      const change = cache.rowChange(3);
      expect(change?.revision).toBe(2);
      expect(change?.count).toBe(1);
      // Old row 10 sat at x = 30 (+1 entity offset); the new row at x = 500.
      expect(Array.from(change?.boxes ?? [])).toEqual([30, 1, 6, 32, 3, 8, 500, 1, 2, 502, 3, 4]);
    });

    it('rebuilds when the retained revision is not exactly one behind or ranges are unknown', () => {
      const cache = new InstanceBoundsCache();
      const transforms = grid(32);
      cache.get(collectionInput(transforms, 1));
      transforms.set(translated(-90, 0, 0), 0);
      cache.get(collectionInput(transforms, 3, [{ start: 0, end: 1 }]));
      expect(cache.inspect()).toMatchObject({ derives: 2, rowUpdates: 0 });
      transforms.set(translated(-95, 0, 0), 0);
      expectSameBounds(
        cache.get(collectionInput(transforms, 4)),
        deriveInstancesUnionBounds({ meshAabb, entityWorld: translated(1, 2, 3), transforms }),
      );
      expect(cache.inspect()).toMatchObject({ derives: 3, rowUpdates: 0 });
      expect(cache.rowChange(3)).toBeUndefined();
    });

    it('re-derives a moving same-size collection in place and still matches the linear fold', () => {
      const cache = new InstanceBoundsCache();
      const transforms = grid(300);
      let seed = 3;
      for (let revision = 1; revision < 12; revision += 1) {
        // Whole-collection motion without dirty-row proof: a full derive per revision.
        for (let row = 0; row < 300; row += 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          transforms.set(translated((seed % 900) - 450, (seed % 31) - 15, seed % 7), row * 16);
        }
        if (revision === 6) transforms[7 * 16 + 13] = Number.NaN;
        if (revision === 7) transforms.set(translated(0, 0, 0), 7 * 16);
        expectSameBounds(
          cache.get(collectionInput(transforms, revision)),
          revision === 6
            ? undefined
            : deriveInstancesUnionBounds({
                meshAabb,
                entityWorld: translated(1, 2, 3),
                transforms,
              }),
        );
      }
      expect(cache.inspect().derives).toBe(11);
      // A resize gets a fresh hierarchy.
      expectSameBounds(
        cache.get(collectionInput(grid(17), 12)),
        deriveInstancesUnionBounds({
          meshAabb,
          entityWorld: translated(1, 2, 3),
          transforms: grid(17),
        }),
      );
    });

    it('returns no-cull while any row is non-finite and recovers when the row is repaired', () => {
      const cache = new InstanceBoundsCache();
      const transforms = grid(40);
      cache.get(collectionInput(transforms, 1));
      transforms[20 * 16] = Number.NaN;
      expect(cache.get(collectionInput(transforms, 2, [{ start: 20, end: 21 }]))).toBeUndefined();
      expect(cache.rowChange(3)).toBeUndefined();
      transforms.set(translated(1, 1, 1), 20 * 16);
      expectSameBounds(
        cache.get(collectionInput(transforms, 3, [{ start: 20, end: 21 }])),
        deriveInstancesUnionBounds({ meshAabb, entityWorld: translated(1, 2, 3), transforms }),
      );
      expect(cache.inspect().rowUpdates).toBe(2);
    });
  });

  it('keeps bounds renderer-derived; the public Instances schema has no bounds field', () => {
    const source = readFileSync(new URL('../components/instances.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bbounds\s*:/);
  });
});
