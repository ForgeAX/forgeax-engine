import { createHash } from 'node:crypto';
import { createBoxGeometry, meshAssetContribution } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type AssetDecoder, type CatalogEntry, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { meshAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers.js';
import { defineAssetKind } from '../asset-kind.js';
import { AssetRegistry } from '../asset-registry.js';
import type { CatalogListener } from '../catalog-source.js';
import { defined } from './assert-defined.js';

const guid = '01900000-0000-7000-8000-000000000061';
const materialGuid = '01900000-0000-7000-8000-000000000062';
const packageUrl = 'https://geometry.invalid/mesh.pack.json';
const gate = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function fixture(
  options: {
    material?: boolean;
    corrupt?: boolean;
    demand?: boolean;
    wait?: () => Promise<void>;
    decoder?: AssetDecoder<MeshAsset>;
  } = {},
) {
  const box = createBoxGeometry(2, 3, 4).unwrap();
  const parsedMaterial = AssetGuid.parse(materialGuid);
  if (!parsedMaterial.ok) throw parsedMaterial.error;
  const mesh = {
    ...box,
    materialSlots: [
      {
        slotName: 'surface',
        ...(options.material ? { defaultMaterial: parsedMaterial.value } : {}),
      },
    ],
  };
  const product = (
    await meshAssetOutputProducer.produce({ guid, sourceKey: 'mesh', asset: mesh })
  ).unwrap();
  const body = defined(product.artifacts.body);
  const descriptor = {
    path: 'mesh.bin',
    contentEncoding: 'identity' as const,
    mediaType: body.mediaType,
    assetCodec: body.assetCodec,
    byteLength: body.bytes.byteLength,
    integrity: {
      algorithm: 'sha256' as const,
      digest: `sha256:${createHash('sha256').update(body.bytes).digest('hex')}`,
    },
  };
  const { pack, publication } = createRuntimePackPublication({
    scopeId: 'geometry-read',
    sourcePath: 'mesh',
    sourceRevision: 'original',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'mesh',
          payload: product.payload,
          refs: options.material ? [materialGuid] : [],
          artifacts: { body: descriptor },
        },
        ...(options.material
          ? [
              {
                guid: materialGuid,
                kind: 'material',
                payload: { kind: 'material' },
                refs: [],
                artifacts: { body: { ...descriptor, path: 'unavailable-material.bin' } },
              },
            ]
          : []),
      ],
    },
  });
  const rows: CatalogEntry[] = pack.assets.map((asset) => ({
    guid: asset.guid,
    kind: asset.kind,
    packageUrl,
    sourcePath: 'mesh',
    publication,
  }));
  const bytes = new Uint8Array(body.bytes);
  if (options.corrupt) bytes[bytes.length - 1] ^= 1;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input) === packageUrl) return Response.json(pack);
    if (String(input) === new URL('mesh.bin', packageUrl).href) {
      await options.wait?.();
      return new Response(bytes);
    }
    return new Response('', { status: 404 });
  });
  let listener: CatalogListener = () => {};
  const assets = new AssetRegistry({ scopeId: 'geometry-read' });
  const lease = assets.installDecoder(
    meshAssetContribution.kind,
    options.decoder ?? meshAssetContribution.decoder,
  );
  assets.installDecoder(defineAssetKind<unknown, 'material'>('material'), {
    async decode({ envelope, artifacts }) {
      return artifacts.read(defined(envelope.artifacts.body));
    },
  });
  assets.setCatalogSource({
    enumerate: async () =>
      ok(
        options.demand
          ? rows.map(({ publication: _publication, ...row }) => ({
              ...row,
              lifecycle: 'missing' as const,
            }))
          : rows,
      ),
    ...(options.demand ? { get: async () => ok(rows) } : {}),
    openPackage: () => fetcher,
    subscribe(next) {
      listener = next;
      return () => {};
    },
  });
  return {
    assets,
    mesh,
    fetcher,
    rows,
    lease,
    change: () => listener({ changed: rows, added: [], removed: [] }),
  };
}

it('returns exact independently owned base geometry without a render Asset kind or runtime identity', async () => {
  const f = await fixture();
  try {
    const geometry = (await f.assets.readMeshGeometry(guid)).unwrap();
    expect(f.assets.inspect().assets).toEqual([]);
    expect(geometry).not.toHaveProperty('kind');
    expect(geometry).not.toHaveProperty('materialSlots');
    const handle = (await f.assets.load(guid, 'mesh')).unwrap(),
      ordinary = f.assets.read(handle).unwrap();
    for (const field of ['vertices', 'attributes', 'indices', 'submeshes', 'aabb'] as const)
      expect(geometry[field]).toEqual(ordinary[field]);
    geometry.vertices[0] += 17;
    expect(f.assets.read(handle).unwrap().vertices).toEqual(ordinary.vertices);
    const again = (await f.assets.readMeshGeometry(guid)).unwrap();
    expect(again.vertices).toEqual(ordinary.vertices);
    expect(again.vertices.buffer).not.toBe(geometry.vertices.buffer);
    f.assets.release(handle).unwrap();
  } finally {
    f.assets.dispose();
  }
});

it('reads a first publication materialized on demand without mistaking its admission for invalidation', async () => {
  const f = await fixture({ demand: true });
  try {
    expect((await f.assets.readMeshGeometry(guid)).unwrap().vertices).toEqual(f.mesh.vertices);
    expect(f.assets.inspect().assets).toEqual([]);
  } finally {
    f.assets.dispose();
  }
});

it('does not consume unavailable default materials, while ordinary complete Mesh loading still rejects them', async () => {
  const f = await fixture({ material: true });
  try {
    expect((await f.assets.readMeshGeometry(guid)).ok).toBe(true);
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      packageUrl,
      'https://geometry.invalid/mesh.bin',
    ]);
    expect(f.assets.inspect().assets).toEqual([]);
    expect((await f.assets.load(guid, 'mesh')).ok).toBe(false);
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toContain(
      'https://geometry.invalid/unavailable-material.bin',
    );
  } finally {
    f.assets.dispose();
  }
});

it('keeps concurrent results independent while sharing verified transport reads', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.assets.readMeshGeometry(guid),
      f.assets.readMeshGeometry(guid),
    ]);
    const first = a.unwrap(),
      second = b.unwrap();
    expect(first).toEqual(second);
    expect(first.vertices.buffer).not.toBe(second.vertices.buffer);
    first.vertices[0] += 1;
    expect(first.vertices).not.toEqual(second.vertices);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.assets.inspect().assets).toEqual([]);
  } finally {
    f.assets.dispose();
  }
});

it('cancels one caller while shared Catalog enumeration is pending without cancelling another reader', async () => {
  const entered = gate(),
    pending = gate(),
    controller = new AbortController();
  const f = await fixture();
  f.assets.setCatalogSource({
    enumerate: async () => {
      entered.release();
      await pending.promise;
      return ok(f.rows);
    },
    openPackage: () => f.fetcher,
    subscribe: () => () => {},
  });
  const cancelled = f.assets.readMeshGeometry(guid, { signal: controller.signal });
  await entered.promise;
  const survivor = f.assets.readMeshGeometry(guid);
  let result: Awaited<typeof cancelled> | undefined;
  void cancelled.then((value) => {
    result = value;
  });
  try {
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-load-cancelled' } });
    pending.release();
    expect((await survivor).unwrap().vertices).toEqual(f.mesh.vertices);
  } finally {
    pending.release();
    await Promise.all([cancelled, survivor]);
    f.assets.dispose();
  }
});

it('preserves runtime edits without letting a source geometry read adopt or overwrite them', async () => {
  const f = await fixture();
  try {
    const original = (await f.assets.readMeshGeometry(guid)).unwrap();
    const handle = (await f.assets.load(guid, 'mesh')).unwrap(),
      edited = createBoxGeometry(4, 6, 8).unwrap();
    f.assets.replace(handle, edited).unwrap();
    const geometry = (await f.assets.readMeshGeometry(guid)).unwrap();
    expect(geometry.vertices).toEqual(original.vertices);
    expect(f.assets.read(handle).unwrap().vertices).toEqual(edited.vertices);
    expect(f.assets.sourceOf(handle)?.modified).toBe(true);
    f.assets.release(handle).unwrap();
  } finally {
    f.assets.dispose();
  }
});

it('rejects corrupt artifact bytes before returning any geometry', async () => {
  const f = await fixture({ corrupt: true });
  try {
    expect(await f.assets.readMeshGeometry(guid)).toMatchObject({
      ok: false,
      error: { code: 'asset-integrity-failed' },
    });
  } finally {
    f.assets.dispose();
  }
});

it.each([
  'invalidate',
  'dispose',
  'replace-source',
  'abort',
  'retire-decoder',
] as const)('rejects a source read interrupted by %s', async (reason) => {
  const entered = gate(),
    pending = gate(),
    controller = new AbortController();
  const f = await fixture({
    wait: async () => {
      entered.release();
      await pending.promise;
    },
  });
  try {
    const reading = f.assets.readMeshGeometry(guid, { signal: controller.signal });
    await entered.promise;
    if (reason === 'invalidate') f.assets.invalidate(guid);
    else if (reason === 'dispose') f.assets.dispose();
    else if (reason === 'replace-source')
      f.assets.setCatalogSource({ enumerate: async () => ok([]), subscribe: () => () => {} });
    else if (reason === 'retire-decoder') f.lease.dispose();
    else controller.abort();
    pending.release();
    expect((await reading).ok).toBe(false);
    expect(f.assets.inspect().assets).toEqual([]);
  } finally {
    pending.release();
    f.assets.dispose();
  }
});

it('does not expose buffers retained by a custom Mesh decoder', async () => {
  const shared = createBoxGeometry(2, 3, 4).unwrap(),
    f = await fixture({ decoder: { decode: async () => ok(shared) } });
  try {
    const geometry = (await f.assets.readMeshGeometry(guid)).unwrap(),
      before = shared.vertices.slice();
    geometry.vertices[0] += 1;
    expect(shared.vertices).toEqual(before);
  } finally {
    f.assets.dispose();
  }
});

it('rejects another Catalog kind and an already aborted read before fetching body bytes', async () => {
  const f = await fixture({ material: true }),
    controller = new AbortController();
  controller.abort();
  try {
    expect((await f.assets.readMeshGeometry(guid, { signal: controller.signal })).ok).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await f.assets.readMeshGeometry(materialGuid)).toMatchObject({
      ok: false,
      error: { code: 'asset-kind-mismatch' },
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally {
    f.assets.dispose();
  }
});

it('rejects an invalid custom decoder geometry instead of returning a partial invalid Mesh', async () => {
  const invalid = { ...createBoxGeometry(2, 3, 4).unwrap(), vertices: new Float32Array(1) };
  const f = await fixture({ decoder: { decode: async () => ok(invalid) } });
  try {
    expect((await f.assets.readMeshGeometry(guid)).ok).toBe(false);
  } finally {
    f.assets.dispose();
  }
});

it('rejects a changed Catalog publication while decoding its former body', async () => {
  const entered = gate(),
    pending = gate(),
    f = await fixture({
      wait: async () => {
        entered.release();
        await pending.promise;
      },
    });
  try {
    const reading = f.assets.readMeshGeometry(guid);
    await entered.promise;
    const previous = defined(f.rows[0]);
    f.rows[0] = {
      ...previous,
      publication: {
        ...defined(previous.publication),
        generation: defined(previous.publication).generation + 1,
        digest: `sha256:${'0'.repeat(64)}`,
      },
    };
    f.change();
    pending.release();
    expect((await reading).ok).toBe(false);
    expect(f.assets.inspect().assets).toEqual([]);
  } finally {
    pending.release();
    f.assets.dispose();
  }
});

it('keeps a shared source transfer alive when only one geometry reader aborts', async () => {
  const entered = gate(),
    pending = gate(),
    controller = new AbortController();
  const f = await fixture({
    wait: async () => {
      entered.release();
      await pending.promise;
    },
  });
  try {
    const first = f.assets.readMeshGeometry(guid, { signal: controller.signal });
    const second = f.assets.readMeshGeometry(guid);
    await entered.promise;
    controller.abort();
    expect((await first).ok).toBe(false);
    pending.release();
    expect((await second).ok).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  } finally {
    pending.release();
    f.assets.dispose();
  }
});
