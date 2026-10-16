import { createBoxGeometry } from '@forgeax/engine-geometry';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { CatalogEntry, MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
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
  const registry = new AssetRegistry({} as never, undefined, [
    { kind: 'mesh', load: () => structuredClone(mesh) },
  ]);
  const fetcher: typeof fetch = async () => {
    throw new Error('unexpected file read');
  };
  registry.setCatalogSource(createCatalogSource({ entries: [] }), fetcher);
  try {
    const result = await registry.preparePublication([row], fetcher, undefined, {
      pack: publication.pack,
    });
    if (representation === 'shared') {
      expect(result).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
      expect(() => registry.commitPreparedPublication(publication.pack)).toThrow();
      return;
    }
    const candidate = result.unwrap();
    const read = defined(candidate.get(guid));
    const retained = async () => (typeof read === 'function' ? await read() : read) as MeshAsset;
    const first = await retained();
    expect(first).toEqual(mesh);
    registry.commitPreparedPublication(publication.pack);
    const loaded = (await registry.loadByGuid<MeshAsset>(registry.parseGuid(guid))).unwrap();
    expect(loaded).toEqual(mesh);
    const bytes = (value: MeshAsset) => {
      const position = value.attributes.position as Float32Array | ArrayBuffer;
      return position instanceof ArrayBuffer ? new Float32Array(position) : position;
    };
    if (representation === 'views') {
      const p = loaded.attributes.position as Float32Array;
      const n = loaded.attributes.normal as Float32Array;
      expect(p.buffer).toBe(n.buffer);
      expect(p.byteOffset).toBe(16);
      expect(p.buffer).not.toBe((mesh.attributes.position as Float32Array).buffer);
    }
    bytes(first)[0] = 123;
    bytes(loaded)[0] = 456;
    expect(bytes(await retained())).toEqual(bytes(mesh));
  } finally {
    registry.clearCatalogSource();
  }
});
