import { createBoxGeometry } from '@forgeax/engine-geometry';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type CatalogEntry, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry.js';
import { createCatalogSource } from '../catalog-source.js';
import { copyPreparedAsset } from '../prepare-payload.js';
import { defined } from './assert-defined.js';

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
  const publication = createRuntimePackPublication({
    scopeId: 'prepared-copy',
    sourcePath: 'custom.pack.ts',
    sourceRevision: 'test',
    packageUrl,
    pack: { assets: [{ guid, kind: 'mesh', payload: {}, refs: [], artifacts: {} }] },
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
  try {
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
    expect(loaded).toEqual(mesh);
    const bytes = (value: MeshAsset) => {
      const position = value.attributes.position as Float32Array | ArrayBuffer;
      return position instanceof ArrayBuffer ? new Float32Array(position) : position;
    };
    if (representation === 'views') {
      const p = loaded.attributes.position as Float32Array;
      const n = loaded.attributes.normal as Float32Array;
      const preparedPosition = first.attributes.position as Float32Array;
      const preparedNormal = first.attributes.normal as Float32Array;
      expect(preparedPosition).toEqual(mesh.attributes.position);
      expect(preparedNormal).toEqual(mesh.attributes.normal);
      expect(preparedPosition.buffer).not.toBe((mesh.attributes.position as Float32Array).buffer);
      // Runtime fields own logical views, so one tracked range write cannot mutate a sibling.
      expect(p.buffer).not.toBe(n.buffer);
      expect(p.byteOffset).toBe(0);
      expect(p.buffer).not.toBe((mesh.attributes.position as Float32Array).buffer);
    }
    bytes(first)[0] = 123;
    bytes(loaded)[0] = 456;
    expect(bytes(await retained())).toEqual(bytes(mesh));
  } finally {
    registry.dispose();
  }
});

it('rejects a prepared publication from another scope before producer publication', async () => {
  const guid = '01900000-0000-7000-8000-000000000996';
  const packageUrl = 'https://prepared.invalid/foreign.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'foreign',
    sourcePath: 'foreign.pack.ts',
    sourceRevision: '1',
    packageUrl,
    pack: { assets: [{ guid, kind: 'mesh', payload: {}, refs: [], artifacts: {} }] },
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
  try {
    const result = await registry.preparePublication([row], fetcher, undefined, {
      pack: publication.pack,
    });
    expect(result.ok).toBe(false);
    const publish = vi.fn();
    expect(() => registry.commitPreparedPublication(publication.pack, publish)).toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect((await registry.enumerateCatalog()).unwrap()).toEqual([]);
  } finally {
    registry.dispose();
  }
});
