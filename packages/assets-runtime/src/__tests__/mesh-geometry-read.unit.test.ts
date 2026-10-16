import { createHash } from 'node:crypto';
import { createBoxGeometry, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { MESH_BIN_HEADER_BYTES, writeMeshBinHeader } from '@forgeax/engine-pack';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type CatalogEntry, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { createCatalogSource } from '../catalog-source.js';
import { defined } from './assert-defined.js';

const A = '11111111-1111-4111-8111-111111111111',
  B = '22222222-2222-4222-8222-222222222222';
const packageUrl = 'https://geometry.invalid/mesh.pack.json',
  bodyUrl = 'https://geometry.invalid/mesh.bin';
function bytesFor(mesh: MeshAsset, dependency: boolean) {
  const projection = deriveVertexLayoutProjection(mesh.attributes),
    index = defined(mesh.indices);
  const json = new TextEncoder().encode(
    JSON.stringify({
      submeshes: mesh.submeshes,
      materialSlots: mesh.materialSlots.map((slot) => ({
        ...slot,
        ...(dependency ? { defaultMaterialRef: 0 } : {}),
      })),
    }),
  );
  const bytes = new Uint8Array(
    MESH_BIN_HEADER_BYTES + mesh.vertices.byteLength + index.byteLength + json.length,
  );
  writeMeshBinHeader(
    {
      version: 4,
      morphBytes: 0,
      projectionVersion: projection.schemaVersion,
      mask: projection.mask,
      digest: projection.digest,
      stride: projection.arrayStride,
      vertexCount: mesh.vertices.byteLength / projection.arrayStride,
      vertexBytes: mesh.vertices.byteLength,
      indexCount: index.length,
      indexWidth: index.BYTES_PER_ELEMENT as 2 | 4,
      indexBytes: index.byteLength,
      jsonBytes: json.length,
    },
    bytes,
  );
  let at = MESH_BIN_HEADER_BYTES;
  for (const data of [
    new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength),
    new Uint8Array(index.buffer, index.byteOffset, index.byteLength),
    json,
  ]) {
    bytes.set(data, at);
    at += data.length;
  }
  return bytes;
}
function fixture(dependency = false) {
  const mesh = createBoxGeometry(2, 3, 4).unwrap(),
    bytes = bytesFor(mesh, dependency);
  const publication = createRuntimePackPublication({
    scopeId: 'mesh-geometry-read',
    sourcePath: 'mesh.pack.ts',
    sourceRevision: 'test',
    packageUrl,
    pack: {
      assets: [
        {
          guid: A,
          kind: 'mesh',
          payload: { kind: 'mesh' },
          refs: dependency ? [B] : [],
          artifacts: {
            body: {
              path: 'mesh.bin',
              mediaType: 'application/x-forgeax-mesh',
              byteLength: bytes.length,
              integrity: {
                algorithm: 'sha256',
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              },
            },
          },
        },
      ],
    },
  });
  const row: CatalogEntry = {
    guid: A,
    kind: 'mesh',
    packageUrl,
    sourcePath: 'mesh.pack.ts',
    publication: publication.publication,
  };
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const reads: string[] = [];
  let delay: Promise<void> | undefined,
    entered: (() => void) | undefined,
    corrupt = false;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    reads.push(url);
    if (url === packageUrl) return new Response(JSON.stringify(publication.pack));
    if (url === bodyUrl) {
      entered?.();
      await delay;
      const body = bytes.slice();
      if (corrupt) body[body.length - 1] = defined(body[body.length - 1]) ^ 1;
      return new Response(body.buffer);
    }
    throw Error(`unexpected dependency/source read ${url}`);
  };
  registry.setCatalogSource(createCatalogSource({ entries: [row] }), fetcher);
  return {
    registry,
    mesh,
    reads,
    guid: registry.parseGuid(A),
    setCorrupt: (value: boolean) => {
      corrupt = value;
    },
    block() {
      let start!: () => void, finish!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      delay = new Promise<void>((resolve) => {
        finish = resolve;
      });
      entered = start;
      return { started, finish };
    },
    dispose() {
      registry.clearCatalogSource();
      registry.invalidateAll();
    },
  };
}

it('reads owned source geometry without loading absent default materials or claiming Ready', async () => {
  const f = fixture(true);
  try {
    const data = (await f.registry.readMeshGeometry(f.guid)).unwrap();
    expect(data.vertices).toEqual(f.mesh.vertices);
    expect(data.indices).toEqual(f.mesh.indices);
    expect(data).not.toHaveProperty('kind');
    expect(data).not.toHaveProperty('materialSlots');
    expect(data).not.toHaveProperty('lods');
    expect(f.registry.lookup(A)).toBeUndefined();
    expect(f.registry.loadState.getReady(A)).toBeUndefined();
    expect(f.registry.lookup(B)).toBeUndefined();
    expect(f.reads).toEqual([packageUrl, bodyUrl]);
    const full = await f.registry.loadByGuid(f.guid);
    expect(full.ok).toBe(false);
    expect(f.registry.lookup(A)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it('keeps ordinary admission unchanged and independently copies already-ready geometry', async () => {
  const f = fixture();
  try {
    const full = (await f.registry.loadByGuid<MeshAsset>(f.guid)).unwrap();
    expect(f.registry.lookup(A)).toBe(full);
    const data = (await f.registry.readMeshGeometry(f.guid)).unwrap();
    expect(data.vertices).toEqual(full.vertices);
    expect(data.vertices.buffer).not.toBe(full.vertices.buffer);
    data.vertices[0] = 99;
    Object.assign(defined(data.submeshes[0]), { indexCount: 0 });
    expect(full.vertices).toEqual(f.mesh.vertices);
    expect(defined(full.submeshes[0]).indexCount).toBeGreaterThan(0);
    expect((await f.registry.loadByGuid(f.guid)).unwrap()).toBe(full);
    expect(f.registry.lookup(A)).toBe(full);
  } finally {
    f.dispose();
  }
});

it('shares physical reads while concurrent source decodes remain independently owned', async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([
      f.registry.readMeshGeometry(f.guid),
      f.registry.readMeshGeometry(f.guid),
    ]);
    const first = a.unwrap(),
      second = b.unwrap();
    expect(first).toEqual(second);
    expect(first.vertices.buffer).not.toBe(second.vertices.buffer);
    first.vertices.fill(88);
    expect(second.vertices).toEqual(f.mesh.vertices);
    expect(f.reads.filter((url) => url === packageUrl)).toHaveLength(1);
    expect(f.reads.filter((url) => url === bodyUrl)).toHaveLength(1);
    expect(f.registry.lookup(A)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it.each([
  'one',
  'all',
] as const)('fences late source geometry after %s invalidation and permits a fresh retry', async (mode) => {
  const f = fixture();
  try {
    const block = f.block(),
      pending = f.registry.readMeshGeometry(f.guid);
    await block.started;
    if (mode === 'one') f.registry.invalidate(A);
    else f.registry.invalidateAll();
    block.finish();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'asset-invalidated' } });
    expect(f.registry.lookup(A)).toBeUndefined();
    expect((await f.registry.readMeshGeometry(f.guid)).unwrap().vertices).toEqual(f.mesh.vertices);
  } finally {
    f.dispose();
  }
});

it('retains artifact integrity failure and never exposes a partial source result', async () => {
  const f = fixture();
  try {
    f.setCorrupt(true);
    expect(await f.registry.readMeshGeometry(f.guid)).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch' },
    });
    expect(f.registry.lookup(A)).toBeUndefined();
    f.setCorrupt(false);
    expect((await f.registry.readMeshGeometry(f.guid)).unwrap().vertices).toEqual(f.mesh.vertices);
  } finally {
    f.dispose();
  }
});

it('refuses detached inline storage without exposing or overwriting the registered payload', async () => {
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const mesh = createBoxGeometry(2, 3, 4).unwrap();
  registry.catalog(A, mesh).unwrap();
  structuredClone(mesh.vertices, { transfer: [mesh.vertices.buffer as ArrayBuffer] });
  expect(await registry.readMeshGeometry(registry.parseGuid(A))).toMatchObject({
    ok: false,
    error: { code: 'asset-parse-failed' },
  });
  expect(registry.lookup(A)).toBe(mesh);
  registry.invalidateAll();
});

it('copies even a custom decoder output retained outside the source read', async () => {
  const f = fixture();
  const shared = createBoxGeometry(2, 3, 4).unwrap();
  const load = vi.spyOn(f.registry.loaders, 'loadPack').mockImplementation(async () => ok(shared));
  try {
    const first = (await f.registry.readMeshGeometry(f.guid)).unwrap();
    first.vertices.fill(90);
    const second = (await f.registry.readMeshGeometry(f.guid)).unwrap();
    expect(second.vertices).toEqual(shared.vertices);
    expect(second.vertices.buffer).not.toBe(shared.vertices.buffer);
    expect(f.registry.lookup(A)).toBeUndefined();
  } finally {
    load.mockRestore();
    f.dispose();
  }
});
