import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';
import { pickTriangle } from '../pick-triangle';
import { skinnedPositions } from '../skinned-positions';
import { skinScene } from './skin-scene.fixture';

const posed = (scene: ReturnType<typeof skinScene>) =>
  skinnedPositions(
    scene.world,
    scene.entity,
    scene.mesh,
    scene.mesh.attributes.position as Float32Array,
  );

describe('posed skin geometry', () => {
  it('matches independently evaluated two-joint blending, IBM, hierarchy and non-uniform scale', () => {
    const scene = skinScene(8);
    scene.pose(0.7, 0.8, 1.3);
    const positions = posed(scene)?.positions;
    expect(positions).toBeDefined();
    const base = scene.mesh.attributes.position as Float32Array;
    const weights = scene.mesh.attributes.skinWeight as Float32Array;
    for (let v = 0; v < base.length / 3; v++) {
      const x = Number(base[v * 3]),
        y = Number(base[v * 3 + 1]),
        w = Number(weights[v * 4 + 1]);
      const upperX = Math.cos(0.8) * x - Math.sin(0.8) * (y - 0.5);
      const upperY = Math.sin(0.8) * x + Math.cos(0.8) * (y - 0.5) + 0.5;
      expect(positions?.[v * 3]).toBeCloseTo(0.7 + 1.3 * ((1 - w) * x + w * upperX), 6);
      expect(positions?.[v * 3 + 1]).toBeCloseTo((1 - w) * y + w * upperY, 6);
    }
  });
  it('never retains stale pose or mistakes a rest-bound overlap for a triangle hit', () => {
    const scene = skinScene();
    expect(pickTriangle(scene.world, scene.camera, 64, 64, 128, 128).status).toBe('hit');
    scene.pose(1.2, 0.8);
    expect(pickTriangle(scene.world, scene.camera, 64, 64, 128, 128).status).toBe('miss');
    scene.pose(0, 0);
    expect(pickTriangle(scene.world, scene.camera, 64, 64, 128, 128).status).toBe('hit');
  });
  it.each([
    'joint',
    'skeleton',
    'count',
    'index',
    'weights',
    'positions',
    'matrix',
    'attributes',
  ] as const)('reports unavailable for invalid %s instead of a false nearest hit', (kind) => {
    const scene = skinScene();
    if (kind === 'attributes') {
      delete scene.mesh.attributes.skinIndex;
      delete scene.mesh.attributes.skinWeight;
    }
    if (kind === 'joint') scene.world.despawn(scene.upper).unwrap();
    if (kind === 'skeleton') scene.world.set(scene.entity, Skin, { skeleton: 0 }).unwrap();
    if (kind === 'count')
      scene.world.set(scene.entity, Skin, { joints: new Uint32Array([scene.root]) }).unwrap();
    if (kind === 'index') (scene.mesh.attributes.skinIndex as Uint16Array)[0] = 99;
    if (kind === 'weights') (scene.mesh.attributes.skinWeight as Float32Array)[0] = NaN;
    if (kind === 'positions') (scene.mesh.attributes.position as Float32Array)[0] = Infinity;
    if (kind === 'matrix') scene.world.get(scene.upper, GlobalTransform).unwrap().world.fill(NaN);
    expect(posed(scene)).toBeUndefined();
    scene.world
      .set(scene.entity, MeshFilter, {
        assetHandle: scene.world.allocSharedRef('MeshAsset', scene.mesh),
      })
      .unwrap();
    const result = pickTriangle(scene.world, scene.camera, 64, 64, 128, 128);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.reason).toBe('skinned-pose-unavailable');
  });
  it('orders a posed foreground hit ahead of a static triangle and reconstructs its barycentric point', () => {
    const scene = skinScene();
    const staticMesh = {
      ...scene.mesh,
      attributes: { position: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]) },
      indices: new Uint16Array([0, 1, 2]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list' as const,
          materialSlot: 0,
        },
      ],
    };
    scene.world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: { assetHandle: scene.world.allocSharedRef('MeshAsset', staticMesh) },
        },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    scene.world.set(scene.root, Transform, { pos: [0, 0, 2] }).unwrap();
    propagateTransforms(scene.world).unwrap();
    const result = pickTriangle(scene.world, scene.camera, 66, 64, 128, 128);
    expect(result.status).toBe('hit');
    if (result.status !== 'hit') return;
    expect(result.hit.entity).toBe(scene.entity);
    expect(result.hit.point[2]).toBeCloseTo(2, 6);
    const positions = posed(scene)?.positions;
    const indices = scene.mesh.indices;
    if (!positions || !indices) throw new Error('Missing skin fixture geometry');
    for (let axis = 0; axis < 3; axis++) {
      let expected = 0;
      for (let lane = 0; lane < 3; lane++)
        expected +=
          Number(positions[Number(indices[result.hit.triangleIndex * 3 + lane]) * 3 + axis]) *
          Number(result.hit.barycentric[lane]);
      expect(result.hit.point[axis]).toBeCloseTo(expected, 6);
    }
  });
  it('keeps non-unit weight sums consistent with GPU affine XYZ, without normalization', () => {
    const scene = skinScene(1);
    (scene.mesh.attributes.skinWeight as Float32Array).fill(0);
    (scene.mesh.attributes.skinWeight as Float32Array)[0] = 0.5;
    scene.pose(1, 0);
    expect(posed(scene)?.positions.slice(0, 3)).toEqual(new Float32Array([0.3, -0.5, 0]));
    scene.world.set(scene.entity, Transform, { pos: [100, 0, 0] }).unwrap();
    expect(posed(scene)?.positions.slice(0, 3)).toEqual(new Float32Array([0.3, -0.5, 0]));
  });
});

it('tests non-indexed and strip skinned triangles through the same public query', () => {
  for (const topology of ['triangle-list', 'triangle-strip'] as const) {
    const scene = skinScene(1);
    const submeshes = [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount: topology === 'triangle-list' ? 3 : 4,
        topology,
        materialSlot: 0,
      },
    ];
    const { indices: _indices, ...source } = scene.mesh;
    const mesh = { ...source, submeshes };
    scene.world
      .set(scene.entity, MeshFilter, { assetHandle: scene.world.allocSharedRef('MeshAsset', mesh) })
      .unwrap();
    scene.pose(0, 0.3);
    expect(pickTriangle(scene.world, scene.camera, 60, 64, 128, 128).status).toBe('hit');
  }
});
