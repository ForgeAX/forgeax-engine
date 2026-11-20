import { createHash } from 'node:crypto';
import {
  copyMeshAttribute,
  createBoxGeometry,
  meshAssetContribution,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import {
  type AssetDecoder,
  type AssetHandle,
  type CatalogEntry,
  err,
  type MeshAsset,
  ok,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { meshAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers.js';
import { defineAssetKind } from '../asset-kind.js';
import { AssetRegistry } from '../asset-registry.js';
import type { CatalogListener, CatalogSource } from '../catalog-source.js';
import { runtimeAssets, runtimeSourceReader } from '../internal/runtime-assets';
import { retainAssetPublications } from '../retain-publication.js';
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
    materialReady?: boolean;
    corrupt?: boolean;
    demand?: boolean;
    wait?: () => Promise<void>;
    waitForMaterial?: () => Promise<void>;
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
        ...(options.material || options.waitForMaterial
          ? [
              {
                guid: materialGuid,
                kind: 'material',
                payload: {
                  kind: 'material',
                  values: {},
                  passes: [{ name: 'main', program: { module: 'forgeax::default-unlit' } }],
                },
                refs: [],
                artifacts: options.materialReady
                  ? {}
                  : { body: { ...descriptor, path: 'unavailable-material.bin' } },
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
      await options.waitForMaterial?.();
      if (options.materialReady) return ok(envelope.payload);
      return artifacts.read(defined(envelope.artifacts.body));
    },
  });
  const source: CatalogSource = {
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
  };
  assets.setCatalogSource(source);
  return {
    assets,
    mesh,
    fetcher,
    pack,
    rows,
    lease,
    source,
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

it('shares one decode between a source geometry read and first Mesh load', async () => {
  const entered = gate();
  const pending = gate();
  const decode = vi.fn<AssetDecoder<MeshAsset>['decode']>(async (input) => {
    entered.release();
    await pending.promise;
    return meshAssetContribution.decoder.decode(input);
  });
  const f = await fixture({ decoder: { decode } });
  try {
    const read = f.assets.readMeshGeometry(guid);
    await entered.promise;
    const loading = f.assets.load(guid, 'mesh');
    await vi.waitFor(() => expect(f.assets.inspectSource()?.counters.loads).toBe(1));
    pending.release();
    const geometry = (await read).unwrap();
    const handle = (await loading).unwrap();
    expect(decode).toHaveBeenCalledTimes(1);
    const adopted = f.assets.read(handle).unwrap();
    expect(geometry.vertices).toEqual(adopted.vertices);
    geometry.vertices[0] += 1;
    expect(f.assets.read(handle).unwrap().vertices).toEqual(adopted.vertices);
    f.assets.release(handle).unwrap();
  } finally {
    pending.release();
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
    f.fetcher.mockClear();
    const geometry = (await f.assets.readMeshGeometry(guid)).unwrap();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(geometry.vertices).toEqual(original.vertices);
    expect(geometry.vertices.buffer).not.toBe(original.vertices.buffer);
    expect(f.assets.read(handle).unwrap().vertices).toEqual(edited.vertices);
    expect(f.assets.sourceOf(handle)?.modified).toBe(true);
    f.assets.release(handle).unwrap();
  } finally {
    f.assets.dispose();
  }
});

it('reads through the current Mesh decoder after a cached output decoder retires', async () => {
  const f = await fixture();
  try {
    const handle = (await f.assets.load(guid, 'mesh')).unwrap();
    f.lease.dispose();
    expect(await f.assets.readMeshGeometry(guid)).toMatchObject({
      ok: false,
      error: { code: 'asset-decoder-missing' },
    });
    const otherMesh = createBoxGeometry(3, 4, 5).unwrap();
    const decode = vi.fn(async () => ok(otherMesh));
    f.assets.installDecoder(meshAssetContribution.kind, { decode });
    expect((await f.assets.readMeshGeometry(guid)).unwrap().vertices).toEqual(otherMesh.vertices);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(f.assets.read(handle).unwrap().vertices).toEqual(f.mesh.vertices);
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

it('loads a prepared Mesh without CPU data and restores the exact revision for ordinary load', async () => {
  const f = await fixture({ material: true, materialReady: true });
  const records = runtimeAssets(f.assets);
  let delivered: MeshAsset | undefined;
  let releases = 0;
  const unbind = records.bindMeshPresenter(async (handle, revision, input) => {
    expect(records.version(handle).unwrap()).toBe(revision);
    const owned = input.capture();
    const backing = owned.vertices.buffer;
    if (!(backing instanceof ArrayBuffer)) throw new Error('expected owned vertex bytes');
    delivered = structuredClone(owned, { transfer: [backing] });
    return ok({
      isCurrent: () => true,
      release: () => {
        releases++;
      },
    });
  });
  try {
    const visual = (await f.assets.load(guid, 'mesh', { usage: 'render' })).unwrap();
    const revision = f.assets.revision(visual).unwrap();
    const material = (await f.assets.load(materialGuid, 'material')).unwrap();
    expect(delivered?.vertices.byteLength).toBeGreaterThan(0);
    expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({
      mode: 'render',
      revision,
      recoveryArtifactBytes: expect.any(Number),
      recoveryArtifactStorage: 'retained-bytes',
    });
    expect(f.assets.meshCpuResidency(visual).unwrap().recoveryArtifactBytes).toBeGreaterThan(0);
    expect(runtimeSourceReader(f.assets, f.source)?.entry(guid)).toBeUndefined();
    expect(records.meshDraw(visual).unwrap().submeshes).toEqual(f.mesh.submeshes);
    expect(records.meshDraw(visual).unwrap().materialSlots[0]?.defaultMaterial).toBe(material);
    expect(f.assets.read(visual)).toMatchObject({
      ok: false,
      error: { code: 'asset-cpu-data-unavailable', detail: { handle: visual, revision } },
    });
    expect(f.assets.snapshot(visual)).toMatchObject({
      ok: false,
      error: { code: 'asset-cpu-data-unavailable' },
    });
    const edit = { attribute: 'position' as const, first: 0, values: Float32Array.of(4, 5, 6) };
    expect(f.assets.writeRange(visual, edit)).toMatchObject({
      ok: false,
      error: { code: 'asset-cpu-data-unavailable' },
    });
    expect(f.assets.copy(visual)).toMatchObject({
      ok: false,
      error: { code: 'asset-cpu-data-unavailable' },
    });
    f.fetcher.mockClear();
    f.assets.clearCatalogSource();
    const reads = await Promise.all([f.assets.load(guid, 'mesh'), f.assets.load(guid, 'mesh')]);
    expect(reads.map((result) => result.unwrap())).toEqual([visual, visual]);
    expect(f.assets.revision(visual).unwrap()).toBe(revision);
    expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({
      mode: 'cpu',
      revision,
      cpuRetentionReason: 'cpu-required',
      recoveryArtifactBytes: 0,
    });
    expect(f.assets.read(visual).unwrap().vertices).toEqual(delivered?.vertices);
    expect(f.assets.read(visual).unwrap().materialSlots[0]?.defaultMaterial).toBe(material);
    expect(releases).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();

    const read = f.assets.read(visual).unwrap();
    const originalPositions = copyMeshAttribute(read, 'position');
    expect(originalPositions).toEqual(copyMeshAttribute(f.mesh, 'position'));
    read.vertices.fill(0);
    expect(copyMeshAttribute(f.assets.read(visual).unwrap(), 'position')).toEqual(
      originalPositions,
    );

    const copy = f.assets.copy(visual).unwrap();
    const snapshot = f.assets.snapshot(visual).unwrap();
    try {
      f.assets.writeRange(visual, edit).unwrap();
      expect(f.assets.revision(visual).unwrap()).toBeGreaterThan(revision);
      expect(copyMeshAttribute(f.assets.read(visual).unwrap(), 'position')?.slice(0, 3)).toEqual(
        edit.values,
      );
      expect(copyMeshAttribute(f.assets.read(copy).unwrap(), 'position')).toEqual(
        originalPositions,
      );
      expect(copyMeshAttribute(snapshot.read<MeshAsset>(visual).unwrap(), 'position')).toEqual(
        originalPositions,
      );
    } finally {
      snapshot.dispose();
      f.assets.release(copy).unwrap();
    }
  } finally {
    unbind();
    f.assets.dispose();
  }
});

it('releases the decoded render Mesh while an unrelated source load is pending', async () => {
  const entered = gate();
  const pending = gate();
  const f = await fixture({
    materialReady: true,
    waitForMaterial: async () => {
      entered.release();
      await pending.promise;
    },
  });
  const unbind = runtimeAssets(f.assets).bindMeshPresenter(async () =>
    ok({ isCurrent: () => true, release() {} }),
  );
  const loading = f.assets.load(materialGuid, 'material');
  try {
    await entered.promise;
    const visual = (await f.assets.load(guid, 'mesh', { usage: 'render' })).unwrap();
    expect(f.assets.meshCpuResidency(visual).unwrap().mode).toBe('render');
    expect(runtimeSourceReader(f.assets, f.source)?.entry(guid)).toBeUndefined();
    pending.release();
    const material = (await loading).unwrap();
    expect(runtimeSourceReader(f.assets, f.source)?.entry(guid)).toBeUndefined();
    f.assets.release(material).unwrap();
    f.assets.release(visual).unwrap();
  } finally {
    pending.release();
    await loading;
    unbind();
    f.assets.dispose();
  }
});

it.each([
  'source load',
  'prepared publication',
] as const)('keeps CPU geometry when a stock artifact cannot recover the custom Mesh from %s', async (origin) => {
  const custom = createBoxGeometry(5, 6, 7).unwrap();
  const f = await fixture({ decoder: { decode: async () => ok(custom) } });
  const present = vi.fn(async () => ok({ isCurrent: () => true, release() {} }));
  const unbind = runtimeAssets(f.assets).bindMeshPresenter(present);
  try {
    if (origin === 'prepared publication') {
      const prepared = await f.assets.preparePublication(f.rows, f.fetcher, undefined, {
        pack: f.pack,
        retainProducerArtifacts: true,
      });
      prepared.unwrap();
      f.assets.commitPreparedPublication(f.pack);
    }
    const original = (await f.assets.load(guid, 'mesh', { usage: 'render' })).unwrap();
    expect(f.assets.meshCpuResidency(original).unwrap()).toMatchObject({
      mode: 'cpu',
      cpuRetentionReason: 'source-unavailable',
    });
    f.lease.dispose();
    f.assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);

    const visual = (await f.assets.load(guid, 'mesh', { usage: 'render' })).unwrap();
    expect(visual).toBe(original);
    expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({
      mode: 'cpu',
      cpuRetentionReason: 'source-unavailable',
    });
    const loaded = (await f.assets.load(guid, 'mesh')).unwrap();
    expect(loaded).toBe(visual);
    expect(f.assets.read(loaded).unwrap().vertices).toEqual(custom.vertices);
    expect(present).not.toHaveBeenCalled();
    f.assets.release(loaded).unwrap();
    f.assets.release(visual).unwrap();
    f.assets.release(original).unwrap();
    expect(f.assets.unload(guid).unwrap()).toBe(true);

    // A new identity decodes with the active lease after the live custom Mesh retires.
    const reloaded = (await f.assets.load(guid, 'mesh')).unwrap();
    expect(reloaded).not.toBe(original);
    expect(f.assets.read(reloaded).unwrap().vertices).toEqual(f.mesh.vertices);
    f.assets.release(reloaded).unwrap();
  } finally {
    unbind();
    f.assets.dispose();
  }
});

it.each([
  'last waiter',
  'one of two waiters',
])('handles cancellation of the %s during a shared Mesh CPU restore', async (waiter) => {
  const f = await fixture();
  const records = runtimeAssets(f.assets);
  const release = vi.fn();
  const promiseStarted = gate();
  const resume = gate();
  const decoded = gate();
  const controller = new AbortController();
  records.bindMeshPresenter(async () => ok({ isCurrent: () => true, release }));
  try {
    const visual = (await f.assets.load(guid, 'mesh', { usage: 'render' })).unwrap();
    const revision = f.assets.revision(visual).unwrap();
    const presentation = defined(records.meshPresentation(visual));
    const readExact = presentation.read.bind(presentation);
    const read = vi.spyOn(presentation, 'read').mockImplementation(async () => {
      promiseStarted.release();
      await resume.promise;
      try {
        return await readExact();
      } finally {
        decoded.release();
      }
    });

    const cancelled = f.assets.load(guid, 'mesh', { signal: controller.signal });
    await promiseStarted.promise;
    const survivor = waiter === 'one of two waiters' ? f.assets.load(guid, 'mesh') : undefined;
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { code: 'asset-load-cancelled' } });
    expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({ mode: 'render', revision });

    resume.release();
    await decoded.promise;
    if (survivor === undefined) {
      // Let the decoder's result reach the Registry before asserting the settled state.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({
        mode: 'render',
        revision,
      });
      expect(release).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
      expect((await f.assets.load(guid, 'mesh')).unwrap()).toBe(visual);
      expect(read).toHaveBeenCalledTimes(2);
    } else {
      expect((await survivor).unwrap()).toBe(visual);
      expect(read).toHaveBeenCalledTimes(1);
    }
    expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({ mode: 'cpu', revision });
    expect(f.assets.read(visual).unwrap().vertices).toEqual(f.mesh.vertices);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    resume.release();
    f.assets.dispose();
  }
});

it('keeps CPU access when an ordinary load finishes before the Render acknowledgement', async () => {
  const f = await fixture();
  const entered = gate();
  const acknowledge = gate();
  const release = vi.fn();
  const unbind = runtimeAssets(f.assets).bindMeshPresenter(async () => {
    entered.release();
    await acknowledge.promise;
    return ok({ isCurrent: () => true, release });
  });
  try {
    const loading = f.assets.load(guid, 'mesh', { usage: 'render' });
    await entered.promise;
    const full = (await f.assets.load(guid, 'mesh')).unwrap();
    const revision = f.assets.revision(full).unwrap();
    acknowledge.release();
    expect((await loading).unwrap()).toBe(full);
    expect(f.assets.meshCpuResidency(full).unwrap()).toMatchObject({
      mode: 'cpu',
      revision,
      cpuRetentionReason: 'cpu-required',
    });
    expect(f.assets.read(full).unwrap().vertices).toEqual(f.mesh.vertices);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    acknowledge.release();
    unbind();
    f.assets.dispose();
  }
});

it('restores the same Mesh for an additional receiver before it builds a baseline', async () => {
  const f = await fixture();
  const records = runtimeAssets(f.assets);
  const release = vi.fn();
  const closeFirst = records.bindMeshPresenter(async () => ok({ isCurrent: () => true, release }));
  try {
    const visual = (await f.assets.load(guid, 'mesh', { usage: 'render' })).unwrap();
    const revision = f.assets.revision(visual).unwrap();
    expect(f.assets.meshCpuResidency(visual).unwrap().mode).toBe('render');
    f.assets.clearCatalogSource();
    const second = vi.fn();
    const closeSecond = records.bindMeshPresenter(second);
    try {
      await f.assets.recoverMeshPresentations();
      expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({
        mode: 'cpu',
        revision,
        cpuRetentionReason: 'multiple-render-receivers',
      });
      expect(f.assets.read(visual).unwrap().vertices).toEqual(f.mesh.vertices);
      expect(second).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      closeSecond();
    }
  } finally {
    closeFirst();
    f.assets.dispose();
  }
});

it('keeps the full Mesh when another receiver joins during visual preparation', async () => {
  const f = await fixture();
  const entered = gate();
  const acknowledge = gate();
  const release = vi.fn();
  const records = runtimeAssets(f.assets);
  const closeFirst = records.bindMeshPresenter(async () => {
    entered.release();
    await acknowledge.promise;
    return ok({ isCurrent: () => true, release });
  });
  try {
    const loading = f.assets.load(guid, 'mesh', { usage: 'render' });
    await entered.promise;
    const closeSecond = records.bindMeshPresenter(async () => err('render-preparation-failed'));
    try {
      await f.assets.recoverMeshPresentations();
      acknowledge.release();
      const handle = (await loading).unwrap();
      expect(f.assets.meshCpuResidency(handle).unwrap()).toMatchObject({
        mode: 'cpu',
        cpuRetentionReason: 'multiple-render-receivers',
      });
      expect(f.assets.read(handle).unwrap().vertices).toEqual(f.mesh.vertices);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      closeSecond();
    }
  } finally {
    acknowledge.release();
    closeFirst();
    f.assets.dispose();
  }
});

it('reports a Render budget rejection while keeping the same CPU Mesh readable', async () => {
  const f = await fixture();
  runtimeAssets(f.assets).bindMeshPresenter(async () => err('render-budget-exceeded'));
  try {
    const visual = (await f.assets.load(guid, 'mesh', { usage: 'render' })).unwrap();
    expect(f.assets.meshCpuResidency(visual).unwrap()).toMatchObject({
      mode: 'cpu',
      cpuRetentionReason: 'render-budget-exceeded',
      recoveryArtifactBytes: 0,
    });
    expect(f.assets.read(visual).unwrap().vertices).toEqual(f.mesh.vertices);
    expect((await f.assets.load(guid, 'mesh')).unwrap()).toBe(visual);
    expect(f.assets.meshCpuResidency(visual).unwrap().cpuRetentionReason).toBe('cpu-required');
  } finally {
    f.assets.dispose();
  }
});

it('does not record a late Render rejection against a replacement Mesh revision', async () => {
  const f = await fixture();
  const entered = gate();
  const acknowledge = gate();
  let pendingHandle: AssetHandle<'mesh'> | undefined;
  let staleCapture: (() => MeshAsset) | undefined;
  runtimeAssets(f.assets).bindMeshPresenter(async (handle, _revision, input) => {
    pendingHandle = handle;
    staleCapture = input.capture;
    entered.release();
    await acknowledge.promise;
    return err('render-budget-exceeded');
  });
  try {
    const loading = f.assets.load(guid, 'mesh', { usage: 'render' });
    await entered.promise;
    const handle = defined(pendingHandle);
    const oldRevision = f.assets.revision(handle).unwrap();
    const replacement = createBoxGeometry(4, 1, 1).unwrap();
    f.assets.replace(handle, replacement).unwrap();
    expect(() => defined(staleCapture)()).toThrow('Mesh presentation changed');
    acknowledge.release();
    expect((await loading).unwrap()).toBe(handle);
    expect(f.assets.revision(handle).unwrap()).toBeGreaterThan(oldRevision);
    expect(f.assets.meshCpuResidency(handle).unwrap().cpuRetentionReason).toBe('not-requested');
    expect(f.assets.read(handle).unwrap().vertices).toEqual(replacement.vertices);
  } finally {
    acknowledge.release();
    f.assets.dispose();
  }
});

it('retains the exact mesh bytes and only shares overlapping decodes', async () => {
  const decode = vi.fn(meshAssetContribution.decoder.decode);
  const f = await fixture({ decoder: { ...meshAssetContribution.decoder, decode } });
  try {
    const row = defined(f.rows[0]);
    const output = defined(row.publication?.outputs[0]);
    const pins = await retainAssetPublications(
      f.assets,
      new Map([[guid, output.digest]]),
      f.rows,
      { enumerate: async () => ok(f.rows), subscribe: () => () => {} },
      f.fetcher,
    );
    const pin = defined(pins.get(guid));
    const read = pin.asset;
    if (typeof read !== 'function') throw new Error('Expected a retained byte source');
    expect(decode).not.toHaveBeenCalled();
    f.fetcher.mockClear();
    f.assets.clearCatalogSource();
    const [first, concurrent] = await Promise.all([read(), read()]);
    expect(first).toBe(concurrent);
    expect(decode).toHaveBeenCalledTimes(1);
    const recovered = await read();
    expect(recovered).toEqual(first);
    expect(recovered).not.toBe(first);
    if (first.kind !== 'mesh' || recovered.kind !== 'mesh') throw new Error('Expected a Mesh');
    expect(recovered.vertices.buffer).not.toBe(first.vertices.buffer);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally {
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
