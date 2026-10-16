import { AssetRegistry, RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import type { MaterialSnapshotCachesByWorld } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

function source() {
  return {
    kind: 'material' as const,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    values: { baseColor: [1, 0, 0, 1] },
  } satisfies MaterialAsset;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function fixture(material: MaterialAsset, registry?: ShaderRegistry) {
  const world = new World();
  registerPropagateTransforms(world);
  const assets = new AssetRegistry(
    registry ??
      ({
        materialArtifact: () => undefined,
        findMaterialArtifact: () => ({ ok: false, error: Error('not registered') }),
      } as unknown as ShaderRegistry),
  );
  const attributes = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const geometry: MeshAsset = {
    kind: 'mesh',
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
    indices: new Uint16Array([0, 1, 2]),
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'body' }],
  };
  const mesh = world.allocSharedRef('MeshAsset', geometry),
    handle = world.allocSharedRef('MaterialAsset', material);
  const skeleton = world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: mat4.identity(mat4.create()),
  });
  const joint = world.spawn({ component: Transform, data: {} }).unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [handle] } },
        { component: Skin, data: { skeleton, joints: [joint] } },
      )
      .unwrap();
  const first = spawn(),
    second = spawn(),
    caches: MaterialSnapshotCachesByWorld = new WeakMap();
  const extract = () => {
    world.update(1 / 60).unwrap();
    return extractFrames([world], 0, assets, undefined, caches);
  };
  return { world, assets, geometry, mesh, handle, joint, first, second, spawn, extract };
}

it('reuses frozen skin materials across real poses but observes runtime value writes and retirement', () => {
  const f = fixture(freeze(source()));
  try {
    const initial = f.extract().renderables;
    expect(initial).toHaveLength(2);
    expect(initial[0]?.material).toBe(initial[1]?.material);
    expect(initial[0]?.material.immutableValues).toBe(true);
    f.world.set(f.joint, Transform, { pos: [2, 0, 0] }).unwrap();
    const moved = f.extract().renderables;
    expect(moved[0]?.material).toBe(initial[0]?.material);
    expect(moved[0]?.skinPose?.jointWorlds[0]?.[12]).toBe(2);
    const value = f.world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: f.handle, parameter: 'baseColor', kind: 2, value: [0, 1, 0, 1] },
      })
      .unwrap();
    const green = f.extract().renderables[0]?.material;
    expect(Array.from(green?.baseColor ?? [])).toEqual([0, 1, 0]);
    expect(green).not.toBe(initial[0]?.material);
    f.world.despawn(value).unwrap();
    expect(Array.from(f.extract().renderables[0]?.material.baseColor ?? [])).toEqual([1, 0, 0]);
    expect(Array.from(initial[0]?.material.baseColor ?? [])).toEqual([1, 0, 0]);
  } finally {
    f.assets.invalidateAll();
  }
});

it('does not use a shared frozen snapshot to admit a later invalid skin mesh', () => {
  const f = fixture(freeze(source()));
  try {
    f.extract();
    const invalid = { ...f.geometry, attributes: { position: f.geometry.attributes.position } };
    const mesh = f.world.allocSharedRef('MeshAsset', invalid);
    f.world.set(f.second, MeshFilter, { assetHandle: mesh }).unwrap();
    const next = f.extract().renderables;
    expect(next.some((row) => row.entityKey === f.first)).toBe(true);
    expect(next.some((row) => row.entityKey === f.second)).toBe(false);
  } finally {
    f.assets.invalidateAll();
  }
});

it('keeps mutable and getter-bearing skin material sources on the original projection path', () => {
  const material = source(),
    f = fixture(material);
  try {
    const first = f.extract().renderables;
    expect(first[0]?.material).not.toBe(first[1]?.material);
    material.values.baseColor[0] = 0;
    material.values.baseColor[2] = 1;
    expect(Array.from(f.extract().renderables[0]?.material.baseColor ?? [])).toEqual([0, 0, 1]);
  } finally {
    f.assets.invalidateAll();
  }
  let reads = 0;
  const value = freeze(source()),
    accessor = Object.freeze({
      ...value,
      get values() {
        reads++;
        return value.values;
      },
    }),
    other = fixture(accessor);
  try {
    const first = other.extract().renderables;
    const before = reads;
    const second = other.extract().renderables;
    expect(reads).toBeGreaterThan(before);
    expect(first[0]?.material).not.toBe(first[1]?.material);
    expect(second[0]?.material).not.toBe(first[0]?.material);
  } finally {
    other.assets.invalidateAll();
  }
});

it('invalidates a frozen skin snapshot when its late shader artifact is admitted', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const f = fixture(freeze(source()), registry);
  try {
    const initial = f.extract().renderables[0]?.material;
    registry.installMaterialArtifact('forgeax::pbr-skin', {
      source: 'fn admitted() {}',
      paramSchema: [],
    });
    const admitted = f.extract().renderables[0]?.material;
    expect(admitted).toBeDefined();
    expect(admitted).not.toBe(initial);
    expect(f.extract().renderables[0]?.material).toBe(admitted);
  } finally {
    f.assets.invalidateAll();
  }
});

it('keeps secondary material resolution separate from primary skin admission', () => {
  const red = freeze(source()),
    blue = freeze({ ...source(), values: { baseColor: [0, 0, 1, 1] } });
  const f = fixture(red);
  try {
    const blueHandle = f.world.allocSharedRef('MaterialAsset', blue);
    const submesh = f.geometry.submeshes[0];
    if (submesh === undefined) throw Error('fixture submesh is required');
    const geometry = {
      ...f.geometry,
      materialSlots: [{ slotName: 'body' }, { slotName: 'other' }],
      submeshes: [...f.geometry.submeshes, { ...submesh, materialSlot: 1 }],
    };
    const mesh = f.world.allocSharedRef('MeshAsset', geometry);
    f.world.set(f.first, MeshFilter, { assetHandle: mesh }).unwrap();
    f.world.set(f.second, MeshFilter, { assetHandle: mesh }).unwrap();
    f.world.set(f.first, MeshRenderer, { materials: [f.handle, blueHandle] }).unwrap();
    f.world.set(f.second, MeshRenderer, { materials: [blueHandle, f.handle] }).unwrap();
    const first = f.extract().renderables;
    expect(first).toHaveLength(2);
    expect(Array.from(first[0]?.materials?.[1]?.baseColor ?? [])).toEqual([0, 0, 1]);
    expect(Array.from(first[1]?.material.baseColor ?? [])).toEqual([0, 0, 1]);
    expect(first[1]?.material).not.toBe(first[0]?.materials?.[1]);
    const second = f.extract().renderables;
    expect(second[0]?.material).toBe(first[0]?.material);
    expect(second[1]?.material).toBe(first[1]?.material);
  } finally {
    f.assets.invalidateAll();
  }
});
