import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { copyMeshAttribute } from '@forgeax/engine-geometry';
import { MeshFilter, samplerContribution } from '@forgeax/engine-render';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import { cameraData } from '../camera';
import {
  geometryValues,
  projectGeometry,
  restoreRigidVertexEdits,
  rigidVertexEdits,
} from '../geometry';
import { SceneProjection } from '../scene';
import { setThreeSceneTracking } from '../source-changes';

it('admits constant UVs for unlit geometry and rechecks tangent requirements after a material change', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(6), 2));
  const basic = new MeshBasicMaterial(),
    standard = new MeshStandardMaterial(),
    normalMap = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1),
    mesh: Mesh = new Mesh(geometry, basic);
  scene.add(mesh);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw Error('missing source mesh');
    const handle = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    const payload = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
    const tangents = copyMeshAttribute(payload, 'tangent');
    expect(tangents).toHaveLength(12);
    expect(Array.from(tangents ?? []).every(Number.isFinite)).toBe(true);
    mesh.material = standard;
    sync();
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toEqual(handle);
    standard.normalMap = normalMap;
    expect(sync).toThrow('no triangle has a valid UV-derived tangent');
    standard.normalMap = null;
    mesh.material = basic;
    sync();
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toEqual(handle);
    const observer = assets.observe().unwrap();
    try {
      for (let i = 0; i < 20; i++) sync();
      expect(observer.read().unwrap().changes).toEqual([]);
    } finally {
      observer.dispose();
    }
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    basic.dispose();
    standard.dispose();
    normalMap.dispose();
  }
});

it('publishes a single vertex body across shared interleaved attribute edits', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const create = vi.spyOn(assets, 'create');
  const replace = vi.spyOn(assets, 'replace');
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const data = new InterleavedBuffer(
    new Float32Array([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 0, 1, 0, 0, 1]),
    5,
  );
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new InterleavedBufferAttribute(data, 3, 0));
  geometry.setAttribute('uv', new InterleavedBufferAttribute(data, 2, 3));
  const material = new MeshBasicMaterial();
  const object = new Mesh(geometry, material);
  scene.add(object);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const source = create.mock.calls.map(([asset]) => asset).find((asset) => asset.kind === 'mesh');
    expect(source?.kind === 'mesh' && source.attributeStorage).toBe('static-streams');
    if (source?.kind !== 'mesh') throw new Error('missing initial mesh');
    expect(source.attributes.position?.byteLength).toBe(0);
    const entity = projection.entityFor(object);
    if (entity === undefined) throw new Error('missing projected entity');
    const handle = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    const records = runtimeAssets(assets);
    expect(records.borrowMeshForPresentation(handle).unwrap().attributeStorage).toBe(
      'static-streams',
    );
    const published = records.resolveStoredAsset<MeshAsset>(handle).unwrap();
    object.position.x += 1;
    sync();
    expect(records.resolveStoredAsset<MeshAsset>(handle).unwrap()).toBe(published);
    const prior = records.pin<MeshAsset>(handle).unwrap();
    try {
      data.array[0] = -2;
      data.array[3] = 0.25;
      data.needsUpdate = true;
      sync();
      expect(
        replace.mock.calls.some(
          ([key, mesh]) =>
            key === handle &&
            typeof mesh === 'object' &&
            mesh !== null &&
            'attributeStorage' in mesh &&
            mesh.attributeStorage === 'static-streams',
        ),
      ).toBe(true);
      expect(records.resolveStoredAsset<MeshAsset>(handle).unwrap().attributeStorage).toBe(
        'static-streams',
      );
      const current = records.borrow<MeshAsset>(handle).unwrap();
      expect(current.attributeStorage).toBe('interleaved');
      expect(copyMeshAttribute(current, 'position')?.[0]).toBe(-2);
      expect(copyMeshAttribute(current, 'uv')?.[0]).toBe(0.25);
      expect(copyMeshAttribute(prior.value, 'position')?.[0]).toBe(-1);
      expect(copyMeshAttribute(prior.value, 'uv')?.[0]).toBe(0);
    } finally {
      prior.dispose();
    }
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});

it.each([
  false,
  true,
])('maps a shared range to the touched native streams (tracked %s)', (tracked) => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const replace = vi.spyOn(assets, 'replace');
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  const data = new InterleavedBuffer(
    new Float32Array([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 0, 1, 0, 0, 1]),
    5,
  );
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new InterleavedBufferAttribute(data, 3, 0));
  geometry.setAttribute('uv', new InterleavedBufferAttribute(data, 2, 3));
  const material = new MeshBasicMaterial(),
    object = new Mesh(geometry, material);
  scene.add(object);
  setThreeSceneTracking(scene, tracked);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const entity = projection.entityFor(object);
    if (entity === undefined) throw Error('unpublished mesh');
    const handle = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    const records = runtimeAssets(assets);
    const initial = records.borrowMeshForPresentation(handle).unwrap();
    const observer = assets.observe().unwrap();
    try {
      const before = records.version(handle).unwrap();
      // An undeclared lane in the same UV must keep its admitted value.
      data.array[3] = 0.75;
      data.array[4] = 0.4;
      data.array[5] = 2;
      data.addUpdateRange(4, 2);
      data.needsUpdate = true;
      sync();
      expect(replace.mock.calls.filter(([key]) => key === handle)).toHaveLength(0);
      const current = records.borrowMeshForPresentation(handle).unwrap();
      expect(current.vertices).toBe(initial.vertices);
      expect(records.version(handle).unwrap()).toBeGreaterThan(before);
      expect(copyMeshAttribute(current, 'uv')?.[1]).toBeCloseTo(0.4);
      expect(copyMeshAttribute(current, 'position')?.[3]).toBe(2);
      expect(copyMeshAttribute(current, 'uv')?.[0]).toBe(0);
      expect(current.aabb?.[3]).toBe(2);
      const ranges = observer
        .read()
        .unwrap()
        .changes.find((change) => change.handle === handle)?.ranges;
      expect(ranges?.length).toBe(2);
      expect(data.updateRanges).toHaveLength(0);
      // A failed frame preserves its input ranges for a retry at this source revision.
      data.array[0] = NaN;
      data.addUpdateRange(0, 1);
      data.needsUpdate = true;
      const accepted = records.version(handle).unwrap();
      expect(sync).toThrow();
      expect(records.version(handle).unwrap()).toBe(accepted);
      expect(data.updateRanges).toHaveLength(1);
      data.array[0] = -3;
      sync();
      expect(data.updateRanges).toHaveLength(0);
      expect(copyMeshAttribute(current, 'position')?.[0]).toBe(-3);
      data.array[10] = 3;
      data.needsUpdate = true;
      sync();
      expect(
        copyMeshAttribute(records.borrowMeshForPresentation(handle).unwrap(), 'position')?.[6],
      ).toBe(3);
    } finally {
      observer.dispose();
    }
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});

it('preserves captured sparse edits after disposal and rejects stale or triangle-dependent ranges', () => {
  const geometry = new BufferGeometry();
  const pos = new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3);
  geometry.setAttribute('position', pos);
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  const unlit = [{ slot: 0, vertexColors: false, tangentBasis: 'normal' as const }];
  const lit = [{ slot: 0, vertexColors: false, tangentBasis: 'uv' as const }];
  const before = geometryValues(geometry, false);
  const base = projectGeometry(
    geometry,
    false,
    unlit,
    'triangle-list',
    {},
    false,
    undefined,
    'static-streams',
  ).unwrap();
  if (!base) throw Error('missing rigid payload');
  pos.setXYZ(0, 4, 5, 6);
  pos.setXYZ(2, 7, 8, 9);
  pos.addUpdateRange(7, 1);
  pos.addUpdateRange(1, 1);
  pos.addUpdateRange(0, 2);
  pos.needsUpdate = true;
  const after = geometryValues(geometry, false);
  const read = (budget: number) => rigidVertexEdits(geometry, before, after, unlit, base, budget);
  const ranges = read(2);
  expect(ranges?.map((r) => r.first)).toEqual([0, 2]);
  if (!ranges) throw Error('expected ranges');
  expect(read(1)).toBeUndefined();
  expect(rigidVertexEdits(geometry, before, after, lit, base, 2)).toBeUndefined();
  pos.needsUpdate = true;
  expect(
    rigidVertexEdits(geometry, before, geometryValues(geometry, false), unlit, base, 2),
  ).toBeUndefined();
  pos.array.fill(123);
  geometry.dispose();
  const recovered = restoreRigidVertexEdits(base, ranges);
  expect(copyMeshAttribute(recovered, 'position')).toEqual(
    Float32Array.of(4, 5, 0, 1, -1, 0, 0, 8, 0),
  );
  expect(copyMeshAttribute(base, 'position')).toEqual(
    Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0),
  );
});

it('updates a changed normal and its derived tangent over the same vertices', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
  const normal = new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3);
  geometry.setAttribute('normal', normal);
  const mat = [{ slot: 0, vertexColors: false, tangentBasis: 'normal' as const }];
  const project = () =>
    projectGeometry(
      geometry,
      false,
      mat,
      'triangle-list',
      {},
      false,
      undefined,
      'static-streams',
    ).unwrap();
  const base = project();
  if (!base) throw Error('missing base');
  const old = geometryValues(geometry, false);
  normal.setXYZ(1, 0, 1, 0);
  normal.addUpdateRange(3, 3);
  normal.needsUpdate = true;
  const edits = rigidVertexEdits(geometry, old, geometryValues(geometry, false), mat, base, 2);
  expect(edits?.map((e) => [e.attribute, e.first])).toEqual([
    ['normal', 1],
    ['tangent', 1],
  ]);
  if (!edits) throw Error('missing derived edit');
  expect(restoreRigidVertexEdits(base, edits).vertices).toEqual(project()?.vertices);
  normal.setXYZ(1, 0, 0, 0);
  expect(
    rigidVertexEdits(geometry, old, geometryValues(geometry, false), mat, base, 2),
  ).toBeUndefined();
  geometry.dispose();
});
