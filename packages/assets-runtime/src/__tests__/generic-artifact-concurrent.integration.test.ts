import { type ArtifactDescriptor, ok, type PluginAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';

const GUID = '01900000-0000-7000-8000-000000000043';
const PACKAGE = 'https://runtime.invalid/generic/pack.json';
const descriptor = (path: string): ArtifactDescriptor => ({
  path,
  mediaType: 'application/octet-stream',
  byteLength: 2,
});

function deferredPack(
  artifacts: Record<string, ArtifactDescriptor> = {
    first: descriptor('first.bin'),
    second: descriptor('second.bin'),
  },
) {
  const payload: PluginAsset = { kind: 'plugin', program: 'fixture:generic', config: {} };
  const pack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [{ guid: GUID, kind: 'plugin', payload, refs: [], artifacts }],
  };
  const originalPack = JSON.stringify(pack);
  const requests: { url: string; release: (response: Response) => void; released: boolean }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === PACKAGE) return new Response(JSON.stringify(pack));
    return new Promise<Response>((release) => requests.push({ url, release, released: false }));
  });
  const registry = new AssetRegistry({} as never);
  registry.setCatalogSource({
    enumerate: async () =>
      ok([{ guid: GUID, kind: 'plugin', packageUrl: PACKAGE, sourcePath: 'fixture/generic' }]),
    openPackage: () => fetcher,
    subscribe: () => () => {},
  });
  const loader = vi.spyOn(registry.loaders, 'loadPack');
  const loads: ReturnType<typeof registry.loadByGuid<PluginAsset>>[] = [];
  const load = () => {
    const pending = registry.loadByGuid<PluginAsset>(registry.parseGuid(GUID));
    loads.push(pending);
    return pending;
  };
  const release = (index: number, bytes = Uint8Array.of(index + 1, index + 2)) => {
    const request = requests[index];
    if (request === undefined) throw new Error(`missing deferred request ${index}`);
    request.released = true;
    request.release(new Response(bytes));
  };
  const drain = async () => {
    // Release late serial reads in a RED run without releasing anything before
    // the concurrency assertion. Only this fixture's pending requests are touched.
    for (let n = 0; n < 30; n++) {
      for (let i = 0; i < requests.length; i++) if (!requests[i]?.released) release(i);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    await Promise.all(loads);
    registry.clearCatalogSource();
    vi.restoreAllMocks();
  };
  const bothStarted = () =>
    vi.waitFor(() => expect(requests).toHaveLength(2), {
      timeout: 300,
      interval: 5,
    });
  return {
    registry,
    loader,
    requests,
    fetcher,
    payload,
    pack,
    originalPack,
    load,
    release,
    drain,
    bothStarted,
  };
}

it('starts both generic reads before responses and passes identical bytes in original entry order', async () => {
  const f = deferredPack();
  const pending = f.load();
  try {
    await f.bothStarted();
    expect(f.loader).not.toHaveBeenCalled();
    f.release(1);
    f.release(0);
    expect((await pending).unwrap()).toEqual(f.payload);
    const input = f.loader.mock.calls[0]?.[0];
    expect(Object.keys(input?.artifacts ?? {})).toEqual(['first', 'second']);
    expect(input?.artifacts.first?.bytes).toEqual(Uint8Array.of(1, 2));
    expect(input?.artifacts.second?.bytes).toEqual(Uint8Array.of(2, 3));
    expect(input?.payload).toEqual(f.payload);
    expect(input?.payload).not.toBe(f.registry.packFiles.get(PACKAGE)?.value?.assets[0]?.payload);
    expect(JSON.stringify(f.pack)).toBe(f.originalPack);
  } finally {
    await f.drain();
  }
});

it('reports the original first descriptor failure even when the second failure finishes first', async () => {
  const f = deferredPack();
  const pending = f.load();
  try {
    await f.bothStarted();
    f.release(1, Uint8Array.of(3, 4, 5));
    f.release(0, Uint8Array.of(7));
    expect(await pending).toMatchObject({
      ok: false,
      error: {
        code: 'asset-artifact-integrity-mismatch',
        detail: { artifactKey: 'first', observed: '1' },
      },
    });
    expect(f.loader).not.toHaveBeenCalled();
    expect(f.registry.lookup(GUID)).toBeUndefined();
  } finally {
    await f.drain();
  }
});

it('retains stream path admission in entry order and never fetches or loads an unsafe stream', async () => {
  const f = deferredPack({
    first: descriptor('first.bin'),
    unsafe: { ...descriptor('../outside.bin'), delivery: 'stream' },
    second: descriptor('second.bin'),
  });
  const pending = f.load();
  try {
    await f.bothStarted();
    f.release(1);
    f.release(0, Uint8Array.of(7));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch', detail: { artifactKey: 'first' } },
    });
    expect(f.requests.map((request) => request.url)).toEqual([
      'https://runtime.invalid/generic/first.bin',
      'https://runtime.invalid/generic/second.bin',
    ]);
    expect(f.loader).not.toHaveBeenCalled();
  } finally {
    await f.drain();
  }
});

it('rejects unsafe stream after preceding reads succeed while forwarding a valid stream without fetching', async () => {
  for (const path of ['../outside.bin', 'video.webm']) {
    const f = deferredPack({
      first: descriptor('first.bin'),
      media: { ...descriptor(path), delivery: 'stream' },
      second: descriptor('second.bin'),
    });
    const pending = f.load();
    try {
      await f.bothStarted();
      f.release(1);
      f.release(0);
      const result = await pending;
      if (path.startsWith('..')) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'asset-parse-failed', detail: { sourcePath: `${PACKAGE}#media` } },
        });
        expect(f.loader).not.toHaveBeenCalled();
      } else {
        expect(result.unwrap()).toEqual(f.payload);
        expect(f.loader.mock.calls[0]?.[0].streams?.media?.url).toBe(
          'https://runtime.invalid/generic/video.webm',
        );
      }
      expect(f.requests).toHaveLength(2);
    } finally {
      await f.drain();
    }
  }
});

it('deduplicates generic artifact reads and the loader across simultaneous same-GUID callers', async () => {
  const f = deferredPack();
  const first = f.load();
  const second = f.load();
  try {
    await f.bothStarted();
    f.release(1);
    f.release(0);
    expect((await first).unwrap()).toBe((await second).unwrap());
    expect(f.requests).toHaveLength(2);
    expect(f.loader).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  } finally {
    await f.drain();
  }
});

it('does not load, publish, or retain old artifacts after an in-flight GUID invalidation', async () => {
  const f = deferredPack();
  const pending = f.load();
  try {
    await f.bothStarted();
    f.registry.invalidate(GUID);
    f.release(1);
    f.release(0);
    expect(await pending).toMatchObject({ ok: false });
    expect(f.loader).not.toHaveBeenCalled();
    expect(f.registry.lookup(GUID)).toBeUndefined();
    expect(
      (f.registry.artifactCache as unknown as { cache: Map<string, unknown> }).cache.size,
    ).toBe(0);
  } finally {
    await f.drain();
  }
});

it('handles a later unexpected read rejection immediately without overriding the earlier structured failure', async () => {
  const f = deferredPack();
  const read = f.registry.artifactCache.read.bind(f.registry.artifactCache);
  const probe = vi
    .spyOn(f.registry.artifactCache, 'read')
    .mockImplementation((key, reader) =>
      key.endsWith('\0second') ? Promise.reject(new Error('later read probe')) : read(key, reader),
    );
  const pending = f.load();
  try {
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2), { timeout: 300, interval: 5 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.loader).not.toHaveBeenCalled();
    f.release(0, Uint8Array.of(7));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch', detail: { artifactKey: 'first' } },
    });
  } finally {
    await f.drain();
  }
});

it('does not call the loader after invalidation during a stream-only ordered collection', async () => {
  const f = deferredPack({ media: { ...descriptor('video.webm'), delivery: 'stream' } });
  vi.stubGlobal('__forgeaxAssetLoadTrace', (event: { phase: string; guid?: string }) => {
    if (event.phase === 'pack.parse.complete' && event.guid === GUID)
      queueMicrotask(() => f.registry.invalidate(GUID));
  });
  const pending = f.load();
  try {
    expect(await pending).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(0);
    expect(f.loader).not.toHaveBeenCalled();
    expect(f.registry.lookup(GUID)).toBeUndefined();
  } finally {
    await f.drain();
    vi.unstubAllGlobals();
  }
});
