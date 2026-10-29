import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

function source(): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    values: { baseColor: [1, 0, 0, 1] },
  };
}

function fixture(material = source()) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
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
  const mesh = assets.create(geometry).unwrap();
  const handle = assets.create(material).unwrap();
  const skeleton = assets
    .create({ kind: 'skeleton', jointCount: 1, inverseBindMatrices: mat4.identity(mat4.create()) })
    .unwrap();
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
    second = spawn();
  const scene = new PersistentRenderScene();
  const caches = scene.materialSnapshotCacheStore();
  const lease = createRenderReadLease(world);
  let requestedEntities = 0;
  const extract = () => {
    world.update(1 / 60).unwrap();
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) => {
        if (typeof request !== 'string' && request.kind === 'partial')
          for (const entities of request.entitiesByWorld) requestedEntities += entities?.size ?? 0;
        return extractFrames([world], 0, assets, caches, {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        });
      },
      [lease],
    );
  };
  return {
    world,
    assets,
    geometry,
    mesh,
    handle,
    joint,
    first,
    second,
    spawn,
    extract,
    requested: () => requestedEntities,
    dispose: () => {
      scene.dispose();
      lease.dispose();
      assets.dispose();
    },
  };
}

it('adopts a shared skin material without extracting its entities or mutating an earlier snapshot', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 126; i++) f.spawn();
    const initial = f.extract().renderables;
    expect(initial).toHaveLength(128);
    const resource = initial.at(0)?.material;
    if (resource === undefined) throw new Error('missing skin material');
    const snapshot = resource.snapshot;
    expect(initial.every((row) => row.material === resource)).toBe(true);
    expect(snapshot.immutableValues).toBe(true);
    f.world.set(f.joint, Transform, { pos: [2, 0, 0] }).unwrap();
    const moved = f.extract().renderables;
    expect(moved.at(0)?.material).toBe(resource);
    expect(moved.at(0)?.skinBinding).toBe(initial.at(0)?.skinBinding);
    const requested = f.requested();
    f.assets.update(f.handle, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    const green = f.extract().renderables;
    expect(f.requested()).toBe(requested);
    expect(green.at(0)?.material).toBe(resource);
    expect(Array.from(resource.snapshot.baseColor)).toEqual([0, 1, 0]);
    expect(Array.from(snapshot.baseColor)).toEqual([1, 0, 0]);
  } finally {
    f.dispose();
  }
});

it('validates each skin binding even when another entity already admitted the shared material', () => {
  const f = fixture();
  try {
    f.extract();
    const position = f.geometry.attributes.position;
    if (position === undefined) throw new Error('missing fixture positions');
    const attributes = { position };
    const mesh = f.assets
      .create({
        ...f.geometry,
        attributes,
        vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
      })
      .unwrap();
    f.world.set(f.second, MeshFilter, { assetHandle: mesh }).unwrap();
    const next = f.extract().renderables;
    expect(next.some((row) => row.entityKey === f.first)).toBe(true);
    expect(next.some((row) => row.entityKey === f.second)).toBe(false);
  } finally {
    f.dispose();
  }
});

it('owns mutable author input and rejects accessors without executing them', () => {
  const input = source();
  const f = fixture(input);
  try {
    const first = f.extract().renderables;
    expect(first.at(0)?.material).toBe(first.at(1)?.material);
    const color = input.values?.baseColor as number[];
    color[0] = 0;
    color[2] = 1;
    expect(Array.from(f.extract().renderables.at(0)?.material.snapshot.baseColor ?? [])).toEqual([
      1, 0, 0,
    ]);
    let reads = 0;
    expect(
      f.assets.create({
        ...input,
        get values() {
          reads++;
          return input.values ?? {};
        },
      }).ok,
    ).toBe(false);
    expect(reads).toBe(0);
  } finally {
    f.dispose();
  }
});

it('shares program-context resources between primary and secondary material slots', () => {
  const f = fixture();
  try {
    const blue = f.assets.create({ ...source(), values: { baseColor: [0, 0, 1, 1] } }).unwrap();
    const submesh = f.geometry.submeshes[0];
    if (submesh === undefined) throw new Error('missing fixture submesh');
    const mesh = f.assets
      .create({
        ...f.geometry,
        materialSlots: [{ slotName: 'body' }, { slotName: 'other' }],
        submeshes: [submesh, { ...submesh, materialSlot: 1 }],
      })
      .unwrap();
    f.world.set(f.first, MeshFilter, { assetHandle: mesh }).unwrap();
    f.world.set(f.second, MeshFilter, { assetHandle: mesh }).unwrap();
    f.world.set(f.first, MeshRenderer, { materials: [f.handle, blue] }).unwrap();
    f.world.set(f.second, MeshRenderer, { materials: [blue, f.handle] }).unwrap();
    const first = f.extract().renderables;
    expect(first).toHaveLength(2);
    expect(first.at(0)?.material).toBe(first.at(1)?.materials[1]);
    expect(first.at(1)?.material).toBe(first.at(0)?.materials[1]);
    f.assets.update(blue, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    const next = f.extract().renderables;
    expect(next.at(0)?.materials[1]).toBe(first.at(1)?.material);
    expect(Array.from(first.at(1)?.material.snapshot.baseColor ?? [])).toEqual([0, 1, 0]);
  } finally {
    f.dispose();
  }
});
