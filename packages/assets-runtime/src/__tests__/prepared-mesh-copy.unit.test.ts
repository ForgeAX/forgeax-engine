import { copyMeshAttribute, createBoxGeometry, interleavedMesh } from '@forgeax/engine-geometry';
import { type CatalogEntry, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it, onTestFinished, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry.js';
import { createCatalogSource } from '../catalog-source.js';
import { copyPreparedAsset } from '../prepare-payload.js';
import { defined } from './assert-defined.js';
import { catalogPack } from './fixtures/catalog-pack';

it('rejects shared loader storage instead of exposing aliases through structuredClone', () => {
  const mesh = createBoxGeometry(2, 3, 4).unwrap();
  const position = mesh.attributes.position as Float32Array;
  const shared = new Float32Array(new SharedArrayBuffer(position.byteLength));
  shared.set(position);
  mesh.attributes.position = shared;
  expect(() => copyPreparedAsset(mesh)).toThrow(/shared/);
});

it.each([
  'buffer',
  'undefined',
  'negative-zero',
  'views',
  'shared',
] as const)('preserves legal loader Mesh %s data and isolates retained and loaded versions', async (representation) => {
  const mesh = createBoxGeometry(2, 3, 4).unwrap();
  const position = mesh.attributes.position as Float32Array;
  if (representation === 'shared') {
    mesh.attributes.position = new Float32Array(new SharedArrayBuffer(position.byteLength));
    mesh.attributes.position.set(position);
  }
  if (representation === 'buffer') mesh.attributes.position = position.buffer as ArrayBuffer;
  if (representation === 'undefined') Object.assign(mesh, { lodHysteresis: undefined });
  if (representation === 'negative-zero') Object.assign(mesh, { lodHysteresis: -0 });
  if (representation === 'views') {
    const normal = mesh.attributes.normal as Float32Array;
    const buffer = new ArrayBuffer(16 + position.byteLength + normal.byteLength);
    mesh.attributes.position = new Float32Array(buffer, 16, position.length);
    mesh.attributes.position.set(position);
    mesh.attributes.normal = new Float32Array(buffer, 16 + position.byteLength, normal.length);
    mesh.attributes.normal.set(normal);
  }
  const guid = '01900000-0000-7000-8000-000000000995';
  const packageUrl = 'https://prepared.invalid/custom.pack.json';
  const publication = catalogPack([{ guid, kind: 'mesh', payload: {}, refs: [], artifacts: {} }], {
    scopeId: 'prepared-copy',
    sourcePath: 'custom.pack.ts',
    sourceRevision: 'test',
    packageUrl,
  });
  const row: CatalogEntry = {
    guid,
    kind: 'mesh',
    packageUrl,
    sourcePath: 'custom.pack.ts',
    publication: publication.publication,
  };
  const registry = new AssetRegistry({
    scopeId: 'prepared-copy',
    shaderRegistry: {} as never,
  });
  registry.installDecoder(defineAssetKind<MeshAsset, 'mesh'>('mesh'), {
    decode: async () => ok(structuredClone(mesh)),
  });
  const fetcher: typeof fetch = async () => {
    throw new Error('unexpected file read');
  };
  registry.setCatalogSource(createCatalogSource({ entries: [row] }), fetcher);
  onTestFinished(() => registry.dispose());
  const result = await registry.preparePublication([row], fetcher, undefined, {
    pack: publication.pack,
  });
  if (representation === 'shared') {
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-decode-failed' } });
    expect(() => registry.commitPreparedPublication(publication.pack)).toThrow();
    return;
  }
  const candidate = result.unwrap();
  const read = defined(candidate.get(guid));
  const retained = async () => (typeof read === 'function' ? await read() : read) as MeshAsset;
  const first = await retained();
  expect(first).toEqual(mesh);
  registry.commitPreparedPublication(publication.pack);
  const handle = (await registry.load(guid, 'mesh')).unwrap();
  const loaded = registry.read(handle).unwrap();
  expect(loaded).toEqual(interleavedMesh(mesh));
  const bytes = (value: MeshAsset) => {
    const result = copyMeshAttribute(value, 'position');
    if (result === undefined) throw Error('missing position');
    return result;
  };
  if (representation === 'views') {
    expect(loaded.attributes.position?.byteLength).toBe(0);
    expect(loaded.attributes.normal?.byteLength).toBe(0);
    const preparedPosition = first.attributes.position as Float32Array;
    const preparedNormal = first.attributes.normal as Float32Array;
    expect(preparedPosition).toEqual(copyMeshAttribute(mesh, 'position'));
    expect(preparedNormal).toEqual(mesh.attributes.normal);
    expect(preparedPosition.buffer).not.toBe((mesh.attributes.position as Float32Array).buffer);
    // Runtime owns packed rows independently; no sibling channel data remains.
    expect(loaded.vertices.buffer).not.toBe(first.vertices.buffer);
    expect(loaded.vertices.buffer).not.toBe(mesh.vertices.buffer);
  }
  first.vertices[0] = 123;
  loaded.vertices[0] = 456;
  (first.attributes.position instanceof ArrayBuffer
    ? new Float32Array(first.attributes.position)
    : (first.attributes.position as Float32Array))[0] = 123;
  expect(registry.read(handle).unwrap().vertices).toEqual(mesh.vertices);
  expect(bytes(await retained())).toEqual(bytes(mesh));
});

it('rejects a prepared publication from another scope before producer publication', async () => {
  const guid = '01900000-0000-7000-8000-000000000996';
  const packageUrl = 'https://prepared.invalid/foreign.pack.json';
  const publication = catalogPack([{ guid, kind: 'mesh', payload: {}, refs: [], artifacts: {} }], {
    scopeId: 'foreign',
    sourcePath: 'foreign.pack.ts',
    packageUrl,
  });
  const row: CatalogEntry = {
    guid,
    kind: 'mesh',
    packageUrl,
    sourcePath: 'foreign.pack.ts',
    publication: publication.publication,
  };
  const registry = new AssetRegistry({ scopeId: 'prepared-copy', shaderRegistry: {} as never });
  registry.installDecoder(defineAssetKind<MeshAsset, 'mesh'>('mesh'), {
    decode: async () => ok(createBoxGeometry(1, 1, 1).unwrap()),
  });
  const fetcher: typeof fetch = async () => {
    throw new Error('unexpected file read');
  };
  registry.setCatalogSource(createCatalogSource({ entries: [] }), fetcher);
  onTestFinished(() => registry.dispose());
  const result = await registry.preparePublication([row], fetcher, undefined, {
    pack: publication.pack,
  });
  expect(result.ok).toBe(false);
  const publish = vi.fn();
  expect(() => registry.commitPreparedPublication(publication.pack, publish)).toThrow();
  expect(publish).not.toHaveBeenCalled();
  expect((await registry.enumerateCatalog()).unwrap()).toEqual([]);
});
