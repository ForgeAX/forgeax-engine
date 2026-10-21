import {
  createBoxGeometry,
  deriveVertexLayoutProjection,
  packMeshBin,
  prepareMeshData,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetHandle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';
import type { MeshRange } from '../runtime-mesh';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

it('owns numeric Mesh defaults and LODs and retains the old closure only while fixed work holds it', () => {
  const assets = new AssetRegistry();
  const geometry = createBoxGeometry(2, 2, 2).unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
      values: { roughness: 0.2 },
    })
    .unwrap();
  const lower = assets.create(geometry).unwrap();
  const root = assets
    .create({
      ...geometry,
      materialSlots: [{ slotName: 'surface', defaultMaterial: material }],
      lods: [{ mesh: lower, screenCoverage: 0.5 }],
    })
    .unwrap();
  expect(runtimeAssets(assets).dependencies(root).unwrap()).toEqual([material, lower]);
  const snapshot = assets.snapshot(root).unwrap();
  assets.release(material).unwrap();
  assets.release(lower).unwrap();
  assets.update(material, { values: { roughness: 0.8 } }).unwrap();
  expect(snapshot.read<MaterialAsset>(material).unwrap().values?.roughness).toBe(0.2);
  assets.replace(root, geometry).unwrap();
  expect(runtimeAssets(assets).dependencies(root).unwrap()).toEqual([]);
  expect(snapshot.read<MeshAsset>(root).unwrap().lods?.[0]?.mesh).toBe(lower);
  snapshot.dispose();
  expect(assets.read(lower).ok).toBe(false);
  expect(assets.read(material).ok).toBe(false);
  assets.dispose();
});

it('rejects foreign, mistyped and cyclic Mesh dependencies before changing content or version', () => {
  const assets = new AssetRegistry();
  const other = new AssetRegistry();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const root = assets.create(geometry).unwrap();
  const lower = assets
    .create({ ...geometry, lods: [{ mesh: root, screenCoverage: 0.5 }] })
    .unwrap();
  const foreign = other.create(geometry).unwrap();
  const observer = assets.observe().unwrap();
  for (const mesh of [lower, root, foreign])
    expect(assets.update(root, { lods: [{ mesh, screenCoverage: 0.5 }] }).ok).toBe(false);
  expect(
    assets.update(root, {
      materialSlots: [
        { slotName: 'invalid', defaultMaterial: lower as unknown as AssetHandle<'material'> },
      ],
    }).ok,
  ).toBe(false);
  expect(assets.read(root).unwrap().lods).toBeUndefined();
  expect(observer.read().unwrap().changes).toHaveLength(0);
  observer.dispose();
  assets.dispose();
  other.dispose();
});

it('links a loaded source Mesh closure once and keeps runtime references out of Pack encoding', async () => {
  const assets = new AssetRegistry();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const materialGuid = AssetGuid.random();
  const lowerGuid = AssetGuid.random();
  const rootGuid = AssetGuid.random();
  const source = {
    ...geometry,
    materialSlots: [{ slotName: 'surface', defaultMaterial: materialGuid }],
    lods: [{ mesh: lowerGuid, screenCoverage: 0.5 }],
  };
  expect(prepareMeshData(source, 'source').ok).toBe(true);
  expect(packMeshBin(source, 'source').ok).toBe(false);
  expect(
    packMeshBin(source, 'source', [AssetGuid.format(materialGuid), AssetGuid.format(lowerGuid)]).ok,
  ).toBe(true);
  publishRuntimeAssets(assets, [
    {
      guid: AssetGuid.format(materialGuid),
      asset: {
        kind: 'material',
        passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
        values: {},
      },
    },
    { guid: AssetGuid.format(lowerGuid), asset: geometry },
    {
      guid: AssetGuid.format(rootGuid),
      asset: {
        ...source,
        materialSlots: [
          { slotName: 'surface', defaultMaterial: AssetGuid.format(materialGuid) as never },
        ],
        lods: [{ mesh: 1 as never, screenCoverage: 0.5 }],
      },
      refs: [AssetGuid.format(materialGuid), AssetGuid.format(lowerGuid)],
    },
  ]);
  const root = (await assets.load(rootGuid, 'mesh')).unwrap();
  const accepted = assets.read(root).unwrap();
  expect(typeof accepted.materialSlots[0]?.defaultMaterial).toBe('number');
  expect(typeof accepted.lods?.[0]?.mesh).toBe('number');
  expect(runtimeAssets(assets).dependencies(root).unwrap()).toHaveLength(2);
  expect(prepareMeshData(accepted, 'runtime').ok).toBe(true);
  expect(packMeshBin(accepted, 'runtime').ok).toBe(false);
  assets.dispose();
});

it.each([
  'uint16',
  'uint32',
] as const)('writes %s index ranges atomically and preserves fixed geometry', (format) => {
  const assets = new AssetRegistry();
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const indices = format === 'uint16' ? new Uint16Array([0, 1, 2]) : new Uint32Array([0, 1, 2]);
  const handle = assets
    .create({
      ...mesh,
      indices,
      submeshes: [
        {
          ...mesh.submeshes[0],
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 24,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
    })
    .unwrap();
  const snapshot = assets.snapshot(handle).unwrap();
  const observer = assets.observe().unwrap();
  const values = format === 'uint16' ? new Uint16Array([3]) : new Uint32Array([3]);
  assets.writeRange(handle, { first: 2, indices: values }).unwrap();
  values.fill(99);
  expect(assets.read(handle).unwrap().indices).toEqual(
    format === 'uint16' ? new Uint16Array([0, 1, 3]) : new Uint32Array([0, 1, 3]),
  );
  expect(snapshot.read<MeshAsset>(handle).unwrap().indices).toEqual(indices);
  const batch = observer.read().unwrap();
  expect(batch.changes[0]?.ranges).toEqual([
    {
      path: ['indices'],
      byteOffset: 2 * values.BYTES_PER_ELEMENT,
      byteLength: values.BYTES_PER_ELEMENT,
    },
  ]);
  batch.accept();
  expect(assets.writeRange(handle, { first: 1, indices: values }).ok).toBe(false);
  expect(assets.writeRange(handle, { first: 3, indices: values }).ok).toBe(false);
  expect(
    assets.writeRange(handle, {
      first: 0,
      indices: format === 'uint16' ? new Uint32Array([1]) : new Uint16Array([1]),
    }).ok,
  ).toBe(false);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  observer.dispose();
  snapshot.dispose();
  assets.dispose();
});

it('publishes channel edits with matching interleaving, conservative bounds and fixed old content', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  const snapshot = assets.snapshot(handle).unwrap();
  const mesh = assets.read(handle).unwrap();
  const positions = mesh.attributes.position as Float32Array;
  for (let i = 0; i < positions.length; i += 3) positions[i] = (positions[i] ?? 0) + 10;
  assets.update(handle, { attributes: mesh.attributes }).unwrap();
  const current = assets.read(handle).unwrap();
  expect(prepareMeshData(current, 'test').ok).toBe(true);
  expect((current.attributes.position as Float32Array)[0]).toBe(positions[0]);
  expect(current.aabb?.[3]).toBe(11);
  positions.fill(999);
  expect((assets.read(handle).unwrap().attributes.position as Float32Array)[0]).not.toBe(999);
  expect(snapshot.read<MeshAsset>(handle).unwrap().aabb?.[3]).toBe(1);
  expect(snapshot.matchesCurrent()).toBe(false);
  snapshot.dispose();
  assets.dispose();
});

it('derives canonical channels from complete interleaved edits and rejects contradictory inputs atomically', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  const mesh = assets.read(handle).unwrap();
  const layout = deriveVertexLayoutProjection(mesh.attributes);
  const position = layout.attributes.find((attribute) => attribute.key === 'position');
  if (position === undefined) throw new Error('missing position');
  mesh.vertices[position.offset / 4] = 5;
  assets.update(handle, { vertices: mesh.vertices }).unwrap();
  const current = assets.read(handle).unwrap();
  expect((current.attributes.position as Float32Array)[0]).toBe(5);
  expect(prepareMeshData(current, 'test').ok).toBe(true);
  const observer = assets.observe().unwrap();
  expect(assets.update(handle, { vertices: mesh.vertices, attributes: mesh.attributes }).ok).toBe(
    false,
  );
  expect(observer.read().unwrap().changes).toHaveLength(0);
  expect((assets.read(handle).unwrap().attributes.position as Float32Array)[0]).toBe(5);
  current.vertices[position.offset / 4] = Infinity;
  expect(assets.replace(handle, current).ok).toBe(false);
  expect(assets.create(current).ok).toBe(false);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  assets.dispose();
});

it('commits attribute and interleaved ranges at one revision without changing untouched buffer identities', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  const records = runtimeAssets(assets);
  const original = records.borrow<MeshAsset>(handle).unwrap();
  const vertices = original.vertices;
  const attributes = original.attributes;
  const positions = attributes.position;
  const normals = attributes.normal;
  const before = records.version(handle).unwrap();
  const snapshot = assets.snapshot(handle).unwrap();
  const observer = assets.observe().unwrap();
  const values = Float32Array.of(4, 5, 6, 7, 8, 9);
  assets.writeRange(handle, { attribute: 'position', first: 1, values }).unwrap();
  values.fill(99);
  const current = records.borrow<MeshAsset>(handle).unwrap();
  expect(current.vertices).toBe(vertices);
  expect(current.attributes).toBe(attributes);
  expect(current.attributes.position).toBe(positions);
  expect(current.attributes.normal).toBe(normals);
  expect((positions as Float32Array).slice(3, 9)).toEqual(Float32Array.of(4, 5, 6, 7, 8, 9));
  expect(current.aabb).toEqual(Float32Array.of(-1, -1, -1, 7, 8, 9));
  expect(prepareMeshData(current, 'range').ok).toBe(true);
  expect(records.version(handle).unwrap()).toBe(before + 1);
  expect(snapshot.read<MeshAsset>(handle).unwrap().aabb).toEqual(
    Float32Array.of(-1, -1, -1, 1, 1, 1),
  );
  const changes = observer.read().unwrap().changes;
  expect(changes).toHaveLength(1);
  const layout = deriveVertexLayoutProjection(attributes);
  expect(changes[0]?.ranges).toEqual([
    { path: ['attributes', 'position'], byteOffset: 12, byteLength: 24 },
    {
      path: ['vertices'],
      byteOffset: layout.arrayStride,
      byteLength: layout.arrayStride + 12,
      rowBytes: 12,
      byteStride: layout.arrayStride,
    },
  ]);
  snapshot.dispose();
  observer.dispose();
  assets.dispose();
});

it('rejects invalid mesh ranges before either representation or its revision changes', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  const before = assets.read(handle).unwrap();
  const observer = assets.observe().unwrap();
  for (const input of [
    { attribute: 'position', first: -1, values: Float32Array.of(1, 2, 3) },
    { attribute: 'position', first: 0.5, values: Float32Array.of(1, 2, 3) },
    { attribute: 'position', first: 999, values: Float32Array.of(1, 2, 3) },
    { attribute: 'position', first: 0, values: Float32Array.of(1, 2) },
    { attribute: 'position', first: 0, values: Float32Array.of(1, NaN, 3) },
    { attribute: 'position', first: 0, values: new Uint16Array([1, 2, 3]) },
    { attribute: 'uv7', first: 0, values: Float32Array.of(1, 2) },
  ]) {
    expect(assets.writeRange(handle, input as MeshRange)).toMatchObject({
      ok: false,
      error: { code: 'asset-invalid-value' },
    });
    expect(assets.read(handle).unwrap()).toEqual(before);
    expect(observer.read().unwrap().changes).toHaveLength(0);
  }
  assets
    .writeRange(handle, { attribute: 'position', first: 0, values: new Float32Array() })
    .unwrap();
  expect(observer.read().unwrap().changes).toHaveLength(0);
  observer.dispose();
  assets.dispose();
});

it('writes a small range in a large mesh within bounded candidate headroom', () => {
  const count = 100_000;
  const attributes = { position: new Float32Array(count * 3) };
  const assets = new AssetRegistry({ limits: { maxBytes: count * 24 + 4096 } });
  const handle = assets
    .create({
      kind: 'mesh',
      vertices: new Float32Array(count * 3),
      attributes,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: count,
          topology: 'point-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'Default' }],
    })
    .unwrap();
  const before = runtimeAssets(assets).inspect().bytes;
  assets
    .writeRange(handle, {
      attribute: 'position',
      first: count - 1,
      values: Float32Array.of(10, 20, 30),
    })
    .unwrap();
  const current = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
  expect(current.vertices.slice(-3)).toEqual(Float32Array.of(10, 20, 30));
  expect(current.aabb?.[5]).toBe(30);
  expect(runtimeAssets(assets).inspect().bytes).toBe(before);
  assets.dispose();
});

it('preserves ArrayBuffer channel storage through validation and range writes', () => {
  const assets = new AssetRegistry();
  const source = createBoxGeometry(2, 2, 2).unwrap();
  const position = (source.attributes.position as Float32Array).slice().buffer;
  const handle = assets
    .create({ ...source, attributes: { ...source.attributes, position } })
    .unwrap();
  new Float32Array(position).fill(999);
  const snapshot = assets.snapshot(handle).unwrap();
  assets
    .writeRange(handle, { attribute: 'position', first: 0, values: Float32Array.of(5, 6, 7) })
    .unwrap();
  const current = assets.read(handle).unwrap();
  expect(current.attributes.position).toBeInstanceOf(ArrayBuffer);
  expect(new Float32Array(current.attributes.position as ArrayBuffer).slice(0, 3)).toEqual(
    Float32Array.of(5, 6, 7),
  );
  expect(
    new Float32Array(snapshot.read<MeshAsset>(handle).unwrap().attributes.position as ArrayBuffer),
  ).toEqual(source.attributes.position);
  snapshot.dispose();
  assets.dispose();
});
