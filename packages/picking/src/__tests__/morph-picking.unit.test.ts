import { mat4 } from '@forgeax/engine-math';
import { Instances, MeshFilter } from '@forgeax/engine-render';
import { MorphWeights } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { currentMeshPositions } from '../current-positions';
import { pickTriangle } from '../pick-triangle';
import { pickVertex, pickVertexOnEntity } from '../pick-vertex';
import { morphScene } from './morph-scene.fixture';

const pick = (s: ReturnType<typeof morphScene>, x = 64) =>
  pickTriangle(s.world, s.camera, x, 64, 128, 128);
describe('live Morph picking', () => {
  it.each([
    true,
    false,
  ])('rejects rest hit and agrees with explicitly deformed geometry (indexed=%s)', (indexed) => {
    const s = morphScene(false, indexed);
    expect(pick(s).status).toBe('miss');
    // Explicit static oracle, independent of the query projection.
    const staticMesh = { ...s.mesh };
    Reflect.deleteProperty(staticMesh, 'morphTargets');
    const positions = new Float32Array(s.mesh.attributes.position as Float32Array);
    for (let i = 0; i < positions.length; i += 3) positions[i] = (positions[i] ?? 0) + 3;
    s.world
      .set(s.entity, MeshFilter, {
        assetHandle: s.world.allocSharedRef('MeshAsset', {
          ...staticMesh,
          attributes: { position: positions },
          aabb: new Float32Array([2.6, -1, 0, 3.4, 1, 0]),
        }),
      })
      .unwrap();
    expect(pick(s).status).toBe('miss');
  });
  it('entity weights override asset defaults and update without stale bounds', () => {
    const s = morphScene();
    s.world.set(s.entity, MorphWeights, { weights: new Float32Array([0]) }).unwrap();
    expect(pick(s).status).toBe('hit');
    s.world.set(s.entity, MorphWeights, { weights: new Float32Array([0.4]) }).unwrap();
    const hit = pick(s, 102.4);
    expect(hit.status).toBe('hit');
    if (hit.status === 'hit') {
      expect(hit.hit.point[0]).toBeCloseTo(1.2, 5);
      expect(hit.hit.distance).toBeCloseTo(4.9, 5);
    }
    expect(pick(s).status).toBe('miss');
    // Raw World entities with no MorphWeights are neutral, as in extraction.
    s.world.removeComponent(s.entity, MorphWeights).unwrap();
    expect(pick(s).status).toBe('hit');
  });
  it('sums multiple positive and negative deltas before Skin world projection', () => {
    const s = morphScene(true);
    const d = s.mesh.morphTargets?.[0]?.position as Float32Array;
    s.world
      .set(s.entity, MeshFilter, {
        assetHandle: s.world.allocSharedRef('MeshAsset', {
          ...s.mesh,
          morphTargets: [{ position: d }, { position: d }],
        }),
      })
      .unwrap();
    s.world.set(s.entity, MorphWeights, { weights: new Float32Array([0.4, -0.2]) }).unwrap();
    s.pose(-0.6, 0);
    expect(pick(s).status).toBe('hit');
    s.pose(0, 0);
    expect(pick(s).status).toBe('miss');
  });
  it('tests explicit instances using morphed local bounds', () => {
    const s = morphScene();
    const transform = mat4.identity(mat4.create());
    transform[12] = -3;
    s.world
      .addComponent(s.entity, { component: Instances, data: { transforms: transform } })
      .unwrap();
    const result = pick(s);
    expect(result.status).toBe('hit');
    if (result.status === 'hit') expect(result.hit.instanceIndex).toBe(0);
  });
  it.each([
    new Float32Array([]),
    new Float32Array([Infinity]),
    new Float32Array([1, 0]),
  ])('reports untestable live weights, never a rest hit', (weights) => {
    const s = morphScene();
    s.world.set(s.entity, MorphWeights, { weights }).unwrap();
    expect(pick(s)).toMatchObject({ status: 'unavailable', reason: 'morph-pose-unavailable' });
  });
  it('vertex queries return the same current surface, including scene bounds', () => {
    const s = morphScene();
    s.world.set(s.entity, MorphWeights, { weights: new Float32Array([0.4]) }).unwrap();
    for (const hit of [
      pickVertexOnEntity(s.world, s.camera, 102.4, 64, 128, 128, s.entity),
      pickVertex(s.world, s.camera, 102.4, 64, 128, 128),
    ]) {
      expect(hit).toBeDefined();
      expect(hit?.deformed).toBe(true);
      expect(Math.abs((hit?.worldPos[0] ?? NaN) - 1.2)).toBeCloseTo(0.4, 5);
    }
    expect(pickVertex(s.world, s.camera, 64, 64, 128, 128)).toBeUndefined();
  });
  it('vertex Skin follows the current joint pose, not the mesh node', () => {
    const s = morphScene(true);
    s.world.set(s.entity, MorphWeights, { weights: new Float32Array([0]) }).unwrap();
    s.pose(1.2, 0);
    const hit = pickVertex(s.world, s.camera, 102.4, 64, 128, 128);
    expect(Math.abs((hit?.worldPos[0] ?? NaN) - 1.2)).toBeCloseTo(0.4, 5);
  });
});

it('invalid Morph inputs never claim a current surface; ArrayBuffer positions remain queryable', () => {
  const s = morphScene();
  for (const delta of [
    new Float32Array([1]),
    new Float32Array((s.mesh.attributes.position as Float32Array).length).fill(NaN),
  ]) {
    const mesh = { ...s.mesh, morphTargets: [{ position: delta }] };
    expect(currentMeshPositions(s.world, s.entity, mesh)).toMatchObject({
      reason: 'morph-pose-unavailable',
    });
  }
  const noPosition = { ...s.mesh, attributes: {} };
  expect(currentMeshPositions(s.world, s.entity, noPosition)).toMatchObject({
    reason: 'cpu-geometry-unavailable',
  });
  s.world.set(s.entity, MorphWeights, { weights: new Float32Array([0]) }).unwrap();
  const position = new Float32Array(s.mesh.attributes.position as Float32Array).buffer;
  const projected = currentMeshPositions(s.world, s.entity, {
    ...s.mesh,
    attributes: { position },
  });
  expect('reason' in projected).toBe(false);
  if (!('reason' in projected)) expect(projected.deformed).toBe(false);
  s.world
    .addComponent(s.entity, {
      component: Instances,
      data: { transforms: mat4.identity(mat4.create()) },
    })
    .unwrap();
  expect(pickVertexOnEntity(s.world, s.camera, 64, 64, 128, 128, s.entity)).toBeUndefined();
});

it.each([false, true])('queries legal normal/tangent-only Morph geometry (Skin=%s)', (skin) => {
  const s = morphScene(skin);
  const count = (s.mesh.attributes.position as Float32Array).length;
  const mesh = {
    ...s.mesh,
    morphTargets: [
      { normal: new Float32Array(count).fill(0.25) },
      { tangent: new Float32Array((count / 3) * 4) },
    ],
  };
  s.world
    .set(s.entity, MeshFilter, { assetHandle: s.world.allocSharedRef('MeshAsset', mesh) })
    .unwrap();
  s.world.set(s.entity, MorphWeights, { weights: new Float32Array([1, -0.5]) }).unwrap();
  expect(pick(s).status).toBe('hit');
  const pose = currentMeshPositions(s.world, s.entity, mesh);
  expect('reason' in pose).toBe(false);
  if (!('reason' in pose)) expect(pose.deformed).toBe(skin);
  expect(pickVertexOnEntity(s.world, s.camera, 64, 64, 128, 128, s.entity)).toBeDefined();
  // Position-bearing targets can follow non-position targets in the same roster.
  const mixed = {
    ...mesh,
    morphTargets: [mesh.morphTargets[0] ?? {}, s.mesh.morphTargets?.[0] ?? {}],
  };
  s.world
    .set(s.entity, MeshFilter, { assetHandle: s.world.allocSharedRef('MeshAsset', mixed) })
    .unwrap();
  s.world.set(s.entity, MorphWeights, { weights: new Float32Array([1, 0.2]) }).unwrap();
  expect(pick(s).status).toBe('miss');
  expect(pick(s, 83.2).status).toBe('hit');
});
