import { AssetRegistry, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  Instances,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { pickTriangle, type TrianglePickOptions, type TrianglePickResult } from '../pick-triangle';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const VP = 600;

function registerMesh(
  world: World,
  assets: AssetRegistry,
  positions: readonly number[],
  indices?: readonly number[],
  topology: 'triangle-list' | 'triangle-strip' = 'triangle-list',
) {
  const position = new Float32Array(positions);
  const result = assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
    kind: 'mesh',
    vertices: position,
    ...(indices === undefined ? {} : { indices: new Uint16Array(indices) }),
    attributes: { position },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices?.length ?? 0,
        vertexCount: Math.floor(position.length / 3),
        topology,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  });
  if (!result.ok) throw result.error;
  return world.allocSharedRef('MeshAsset', result.value) as Handle<'MeshAsset', 'shared'>;
}

function makeScene() {
  const world = new World();
  const assets = new AssetRegistry(makeMockShaderRegistry());
  const material = assets.catalog(AssetGuid.format(AssetGuid.random()), {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 1, 1] },
  });
  if (!material.ok) throw material.error;
  const materialHandle = world.allocSharedRef('MaterialAsset', material.value);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_PERSPECTIVE,
          left: -1,
          right: 1,
          top: 1,
          bottom: -1,
        },
      },
    )
    .unwrap();
  return { world, assets, materialHandle, camera };
}

function spawnMesh(
  scene: ReturnType<typeof makeScene>,
  mesh: Handle<'MeshAsset', 'shared'>,
  transform: { pos?: [number, number, number]; scale?: [number, number, number] } = {},
) {
  return scene.world
    .spawn(
      {
        component: Transform,
        data: {
          pos: transform.pos ?? [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: transform.scale ?? [1, 1, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [scene.materialHandle] } },
    )
    .unwrap();
}

function spawnInstancedMesh(
  scene: ReturnType<typeof makeScene>,
  mesh: Handle<'MeshAsset', 'shared'>,
  translations: readonly number[],
) {
  const transforms = new Float32Array(translations.length * 16);
  for (let index = 0; index < translations.length; index += 1) {
    const offset = index * 16;
    transforms[offset] = 1;
    transforms[offset + 5] = 1;
    transforms[offset + 10] = 1;
    transforms[offset + 15] = 1;
    transforms[offset + 12] = translations[index] as number;
  }
  return scene.world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [scene.materialHandle] } },
      { component: Instances, data: { transforms } },
    )
    .unwrap();
}

function unsupportedSkinnedMesh(scene: ReturnType<typeof makeScene>) {
  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    attributes: {
      position: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
      skinIndex: new Uint16Array(12),
      skinWeight: new Float32Array(12),
    },
    aabb: new Float32Array([-1, -1, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 0, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
  return scene.world.allocSharedRef('MeshAsset', mesh) as Handle<'MeshAsset', 'shared'>;
}

function query(
  scene: ReturnType<typeof makeScene>,
  x = VP / 2,
  y = VP / 2,
  options: TrianglePickOptions = {},
): TrianglePickResult {
  propagateTransforms(scene.world);
  return pickTriangle(scene.world, scene.camera, x, y, VP, VP, options);
}

describe('pickTriangle', () => {
  it('returns the nearest exact hit and barycentric point', () => {
    const scene = makeScene();
    const near = registerMesh(scene.world, scene.assets, [-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2]);
    const far = registerMesh(
      scene.world,
      scene.assets,
      [-1, -1, -2, 1, -1, -2, 0, 1, -2],
      [0, 1, 2],
    );
    const nearEntity = spawnMesh(scene, near);
    spawnMesh(scene, far);

    const result = query(scene);
    expect(result.status).toBe('hit');
    if (result.status !== 'hit') return;
    expect(result.hit.entity).toBe(nearEntity);
    expect(result.hit.point[2]).toBeCloseTo(0, 4);
    expect(result.hit.distance).toBeCloseTo(4.9, 2);
    expect(result.hit.barycentric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    expect(result.hit.precision).toBe('triangle');
  });

  it('uses transformed world vertices, so a wall opening reaches the rear sign', () => {
    const scene = makeScene();
    // Four bars surround the center opening. Their combined AABB covers the
    // whole wall, but no triangle occupies the center ray.
    const wallPositions = [
      -1, 0.5, 0, 1, 0.5, 0, 1, 1, 0, -1, 0.5, 0, 1, 1, 0, -1, 1, 0, -1, -1, 0, 1, -1, 0, 1, -0.5,
      0, -1, -1, 0, 1, -0.5, 0, -1, -0.5, 0, -1, -0.5, 0, -0.5, -0.5, 0, -0.5, 0.5, 0, -1, -0.5, 0,
      -0.5, 0.5, 0, -1, 0.5, 0, 0.5, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0.5, -0.5, 0, 1, 0.5, 0, 0.5,
      0.5, 0,
    ];
    const wall = registerMesh(scene.world, scene.assets, wallPositions);
    const sign = registerMesh(
      scene.world,
      scene.assets,
      [-0.5, -0.5, -2, 0.5, -0.5, -2, 0.5, 0.5, -2, -0.5, 0.5, -2],
    );
    const wallEntity = spawnMesh(scene, wall);
    const signEntity = spawnMesh(scene, sign);

    const result = query(scene);
    expect(result.status).toBe('hit');
    if (result.status !== 'hit') return;
    expect(result.hit.entity).toBe(signEntity);
    expect(result.hit.entity).not.toBe(wallEntity);
  });

  it('handles non-uniform transformed instances and reports unavailable CPU/skinned data', () => {
    const scene = makeScene();
    const mesh = registerMesh(
      scene.world,
      scene.assets,
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0],
      [0, 1, 2],
    );
    const entity = spawnMesh(scene, mesh, { pos: [0, 0, 0], scale: [2, 3, 1] });
    const transformed = query(scene);
    expect(transformed.status).toBe('hit');
    if (transformed.status === 'hit') expect(transformed.hit.entity).toBe(entity);

    const unsupported = unsupportedSkinnedMesh(scene);
    spawnMesh(scene, unsupported);
    const result = query(scene);
    expect(result.status).toBe('unavailable');
  });

  it('resolves explicit Instances matrices and identifies the hit ordinal', () => {
    const scene = makeScene();
    const mesh = registerMesh(
      scene.world,
      scene.assets,
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0],
      [0, 1, 2],
    );
    const entity = spawnInstancedMesh(scene, mesh, [5, 0]);

    const result = query(scene, VP / 2, VP / 2);
    expect(result.status).toBe('hit');
    if (result.status !== 'hit') return;
    expect(result.hit.entity).toBe(entity);
    expect(result.hit.instanceIndex).toBe(1);
  });

  it('fails closed when authored Instances contain an incomplete matrix', () => {
    const scene = makeScene();
    const mesh = registerMesh(
      scene.world,
      scene.assets,
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0],
      [0, 1, 2],
    );
    const entity = spawnInstancedMesh(scene, mesh, [0]);
    scene.world.set(entity, Instances, { transforms: new Float32Array(15) }).unwrap();

    const result = query(scene);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toBe('instance-transforms-unavailable');
    }
  });

  it('returns a miss for an indexed/non-indexed mesh outside the ray', () => {
    const scene = makeScene();
    const mesh = registerMesh(scene.world, scene.assets, [-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    spawnMesh(scene, mesh, { pos: [10, 0, 0] });
    expect(query(scene).status).toBe('miss');
  });

  it('intersects indexed triangle strips with alternating winding', () => {
    const scene = makeScene();
    const positions = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0];
    const indexed = registerMesh(
      scene.world,
      scene.assets,
      positions,
      [0, 1, 2, 3],
      'triangle-strip',
    );
    const indexedEntity = spawnMesh(scene, indexed);

    const result = query(scene);
    expect(result.status).toBe('hit');
    if (result.status !== 'hit') return;
    expect(result.hit.entity).toBe(indexedEntity);
    expect(result.hit.triangleIndex).toBe(0);
  });
});

describe('current skin triangle pose', () => {
  it('hits a posed triangle outside its rest bounds and ignores the mesh node transform', () => {
    const scene = makeScene();
    const source = unsupportedSkinnedMesh(scene);
    const resolved = resolveAssetHandle<MeshAsset>(scene.world, source).unwrap() as MeshAsset;
    (resolved.attributes.position as Float32Array).set([-5, -1, 0, -3, -1, 0, -4, 1, 0]);
    (resolved.attributes.skinWeight as Float32Array).set([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    resolved.aabb?.set([-5, -1, 0, -3, 1, 0]);
    const mesh = scene.world.allocSharedRef('MeshAsset', resolved);
    const joint = scene.world.spawn({ component: Transform, data: { pos: [4, 0, 0] } }).unwrap();
    const skeleton = scene.world.allocSharedRef('SkeletonAsset', {
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: mat4.identity(mat4.create()),
      jointPaths: ['root'],
    });
    const entity = spawnMesh(scene, mesh, { pos: [100, 20, 30], scale: [2, 3, 4] });
    scene.world
      .addComponent(entity, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint]) },
      })
      .unwrap();
    const hit = query(scene);
    expect(hit.status).toBe('hit');
    if (hit.status !== 'hit') return;
    expect(hit.hit.entity).toBe(entity);
    expect(hit.hit.point).toEqual([0, 0, 0]);
    expect(hit.hit.barycentric).toEqual([0.25, 0.25, 0.5]);
    scene.world.set(joint, Transform, { pos: [8, 0, 0] }).unwrap();
    expect(query(scene).status).toBe('miss');
  });
});
