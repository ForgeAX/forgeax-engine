import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveInstancesUnionBounds } from '../instances-derived-bounds';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { SceneRows } from '../scene/scene-rows';

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

function instanceScene() {
  const rows = new SceneRows();
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const publish = (localAabb = meshAabb, world = entityWorld, transforms = IDENTITY) => {
    const source = {
      entityKey: 7,
      material,
      materials: [material],
      materialBindingSources: [],
      transform: { world },
      localAabb,
      instances: { transforms, instanceCount: transforms.length / 16, cacheKey: 7, archVersion: 1 },
    };
    rows.apply([{ kind: 'update', entityKey: 7, snapshot: source }], [], true);
  };
  const bounds = () => {
    const slot = rows.lookup(7);
    if (slot === undefined) throw new Error('expected instance row');
    const box = rows.cullingWorldBoundsAt(slot);
    return box === undefined ? undefined : Float32Array.of(...box.min, ...box.max);
  };
  return { rows, publish, bounds };
}

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

  it('reads only the addressed world transform in a packed pose column', () => {
    const poses = new Float32Array(48).fill(Number.NaN);
    poses.set(translated(3, 7, -2), 16);
    const input = {
      meshAabb,
      entityWorld: poses,
      entityWorldOffset: 16,
      transforms: translated(5),
    };
    expect(deriveInstancesUnionBounds(input)).toEqual(new Float32Array([7, 6, -3, 9, 8, -1]));
    poses[28] = -4;
    expect(deriveInstancesUnionBounds(input)).toEqual(new Float32Array([0, 6, -3, 2, 8, -1]));
    expect(deriveInstancesUnionBounds({ ...input, entityWorldOffset: 40 })).toBeUndefined();
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

  it('reads the accepted mesh, entity pose and instance collection after each change', () => {
    const scene = instanceScene();
    scene.publish();
    expect(scene.bounds()).toEqual(meshAabb);
    expect(scene.bounds()).toEqual(meshAabb);
    expect(scene.rows.instanceBoundsStatistics().derives).toBe(1);
    scene.publish(meshAabb, entityWorld, translated(9));
    expect(scene.bounds()?.[0]).toBe(8);
    scene.publish(meshAabb, translated(10));
    expect(scene.bounds()?.[0]).toBe(9);
    const widened = Float32Array.of(-2, -1, -1, 2, 1, 1);
    scene.publish(widened);
    expect(scene.bounds()).toEqual(widened);
    scene.publish();
    expect(scene.bounds()).toEqual(meshAabb);
  });

  it('isolates the same entity and producer revision in independent Scenes', () => {
    const first = instanceScene();
    const second = instanceScene();
    first.publish();
    second.publish(meshAabb, translated(20));
    expect(second.bounds()?.[0]).toBe(19);
    expect(first.bounds()?.[0]).toBe(-1);
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
    const scene = instanceScene();
    scene.publish();
    scene.bounds();
    scene.bounds();
    scene.publish(meshAabb, entityWorld, translated(1));
    scene.bounds();
    scene.rows.apply([{ kind: 'remove', entityKey: 7 }], [], true);
    expect(scene.rows.instanceBoundsStatistics()).toEqual({
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
  const scene = instanceScene();
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
    scene.publish(mesh, world, transforms);
    const actual = scene.bounds();
    const exact = deriveInstancesUnionBounds({ meshAabb: mesh, entityWorld: world, transforms });
    expect(exact).toBeDefined();
    expect(actual).toEqual(exact);
  }
  expect(scene.rows.instanceBoundsStatistics().derives).toBe(10);
});
