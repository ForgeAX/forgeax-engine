import { expect, it, onTestFinished, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { runtimeAssets } from '../internal/runtime-assets';
import { defined } from './assert-defined';
import { catalogPack } from './fixtures/catalog-pack';

function fixture() {
  const kind = defineAssetKind<{ value: number }>('batch-value');
  const guids = [1, 2, 3].map((i) => `00000000-0000-7000-8000-00000000000${i}`);
  const packageUrl = 'https://fixture.invalid/batch.pack.json';
  const { pack, rows } = catalogPack(
    guids.map((guid, value) => ({
      guid,
      kind: kind.kind,
      refs: [],
      artifacts: {},
      payload: { value },
    })),
    { sourcePath: 'batch.pack', packageUrl },
  );
  const fetcher = vi.fn(async () => Response.json(pack));
  const source = createCatalogSource({
    entries: rows,
    fetch: fetcher,
  });
  const assets = new AssetRegistry({ catalog: source });
  const decode = vi.fn(async ({ envelope }: { envelope: { payload: unknown } }) => ({
    ok: true as const,
    value: envelope.payload as { value: number },
  }));
  assets.installDecoder(kind, { decode });
  return { assets, source, kind, guids, fetcher, decode };
}

it('opens one verified Pack for a serial batch and releases that scope before the next load', async () => {
  const f = fixture();
  onTestFinished(() => f.assets.dispose());
  const handles = (await f.assets.loadMany(f.guids.slice(0, 2), f.kind)).unwrap();
  expect(handles.map((h) => f.assets.read(h).unwrap().value)).toEqual([0, 1]);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  (await f.assets.load(defined(f.guids[2]), f.kind)).unwrap();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it('retains duplicate requested handles once per entry', async () => {
  const f = fixture();
  onTestFinished(() => f.assets.dispose());
  const handles = (
    await f.assets.loadMany([defined(f.guids[0]), defined(f.guids[0])], f.kind)
  ).unwrap();
  expect(handles[0]).toBe(handles[1]);
  expect(runtimeAssets(f.assets).refcount(defined(handles[0]))).toBe(3);
  f.assets.release(defined(handles[0])).unwrap();
  expect(f.assets.validate(defined(handles[1])).ok).toBe(true);
  f.assets.release(defined(handles[1])).unwrap();
  expect(runtimeAssets(f.assets).refcount(defined(handles[0]))).toBe(1);
});

it('cancels between serial reads, releases admitted grants and admits no later decode', async () => {
  const f = fixture(),
    controller = new AbortController();
  const release = vi.spyOn(f.assets, 'release');
  f.decode.mockImplementationOnce(async ({ envelope }) => {
    controller.abort();
    return { ok: true, value: envelope.payload as { value: number } };
  });
  onTestFinished(() => f.assets.dispose());
  const result = await f.assets.loadMany(f.guids, f.kind, { signal: controller.signal });
  expect(result.ok).toBe(false);
  expect(f.decode).toHaveBeenCalledTimes(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
});

it('releases successful earlier grants when a later GUID is invalid', async () => {
  const f = fixture();
  const retain = vi.spyOn(f.assets, 'load'),
    release = vi.spyOn(f.assets, 'release');
  onTestFinished(() => f.assets.dispose());
  const result = await f.assets.loadMany([defined(f.guids[0]), 'not-a-guid'], f.kind);
  expect(result.ok).toBe(false);
  const first = await defined(retain.mock.results[0]).value;
  expect(first.ok).toBe(true);
  expect(release).toHaveBeenCalledWith(first.value);
  expect(runtimeAssets(f.assets).refcount(first.value)).toBe(1);
});

it.each([
  1, 3,
])('rolls back cancellation after completed grant %s, including the last entry', async (cancelAt) => {
  const f = fixture(),
    controller = new AbortController();
  const original = f.assets.load.bind(f.assets);
  const calls = vi.spyOn(f.assets, 'load').mockImplementation(async (guid, kind, options) => {
    const result = await original(guid, kind as typeof f.kind, options);
    if (calls.mock.calls.length === cancelAt) controller.abort();
    return result;
  });
  const release = vi.spyOn(f.assets, 'release');
  onTestFinished(() => f.assets.dispose());
  expect((await f.assets.loadMany(f.guids, f.kind, { signal: controller.signal })).ok).toBe(false);
  expect(f.decode).toHaveBeenCalledTimes(cancelAt);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(cancelAt);
  const first = await defined(calls.mock.results[0]).value;
  expect(runtimeAssets(f.assets).refcount(first.value)).toBe(1);
});

it('does not mix a replaced Catalog source into a batch', async () => {
  const f = fixture();
  const original = f.assets.load.bind(f.assets);
  const calls = vi.spyOn(f.assets, 'load').mockImplementation(async (guid, kind, options) => {
    const result = await original(guid, kind as typeof f.kind, options);
    f.assets.setCatalogSource(f.source);
    return result;
  });
  const release = vi.spyOn(f.assets, 'release');
  onTestFinished(() => f.assets.dispose());
  const result = await f.assets.loadMany(f.guids, f.kind);
  expect(result.ok).toBe(false);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

it('keeps Pack verification shared across awaited host progress boundaries', async () => {
  const f = fixture();
  const progress: number[][] = [];
  onTestFinished(() => f.assets.dispose());
  const handles = (
    await f.assets.loadMany(f.guids, f.kind, {
      onProgress: async (completed, total) => {
        progress.push([completed, total]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    })
  ).unwrap();
  expect(progress).toEqual([
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(handles.map((h) => f.assets.read(h).unwrap().value)).toEqual([0, 1, 2]);
});

it('rolls back every admitted grant when progress throws', async () => {
  const f = fixture(),
    release = vi.spyOn(f.assets, 'release');
  onTestFinished(() => f.assets.dispose());
  await expect(
    f.assets.loadMany(f.guids, f.kind, {
      onProgress: (completed) => {
        if (completed === 2) throw Error('host progress failed');
      },
    }),
  ).rejects.toThrow('host progress failed');
  expect(f.decode).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(2);
});

it('rejects cancellation during final progress and releases all caller grants', async () => {
  const f = fixture(),
    controller = new AbortController(),
    release = vi.spyOn(f.assets, 'release');
  onTestFinished(() => f.assets.dispose());
  const result = await f.assets.loadMany(f.guids, f.kind, {
    signal: controller.signal,
    onProgress: async (completed, total) => {
      await Promise.resolve();
      if (completed === total) controller.abort();
    },
  });
  expect(result.ok).toBe(false);
  expect(release).toHaveBeenCalledTimes(3);
});

it('rejects Catalog replacement during final progress', async () => {
  const f = fixture(),
    release = vi.spyOn(f.assets, 'release');
  onTestFinished(() => f.assets.dispose());
  const result = await f.assets.loadMany(f.guids, f.kind, {
    onProgress: (completed, total) => {
      if (completed === total) f.assets.setCatalogSource(f.source);
    },
  });
  expect(result.ok).toBe(false);
  expect(release).toHaveBeenCalledTimes(3);
});
