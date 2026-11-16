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

  it('keeps identical entity handles isolated between independent Renderer caches', () => {
    const cache = new InstanceBoundsCache();
    const first = cache.get({
      entityKey: 7,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld,
      transforms: new Float32Array(IDENTITY),
    });
    const second = new InstanceBoundsCache().get({
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
    });
  });

  it('keeps bounds renderer-derived; the public Instances schema has no bounds field', () => {
    const source = readFileSync(new URL('../components/instances.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bbounds\s*:/);
  });
});

it('re-derives exact bounds under mixed negative scale and shear on every mesh edit', () => {
  const cache = new InstanceBoundsCache();
  const transforms = new Float32Array(64 * 16);
  for (let row = 0; row < 64; row++) {
    const matrix = translated((row % 5) * 3, row % 11, row % 7);
    matrix[0] = row % 2 ? -2 : 3;
    matrix[4] = (row % 3) - 1;
    matrix[9] = (row % 5) * 0.25;
    matrix[10] = 0.5;
    transforms.set(matrix, row * 16);
  }
  const world = new Float32Array([-2, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 3, 0, 3, -5, 2, 1]);
  for (let revision = 1; revision <= 10; revision++) {
    const mesh = new Float32Array([-revision, -2, -3, 2, revision, 3]);
    const actual = cache.get({
      entityKey: 1,
      meshGeneration: revision,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb: mesh,
      entityWorld: world,
      transforms,
    });
    const exact = deriveInstancesUnionBounds({ meshAabb: mesh, entityWorld: world, transforms });
    expect(exact).toBeDefined();
    expect(actual).toEqual(exact);
  }
  expect(cache.inspect().derives).toBe(10);
});
