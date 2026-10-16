import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const GUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('asset registry cache cleanup', () => {
  it('releases raw artifact reads without invalidating loaded payloads or adopted Pack metadata', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'host-blob',
      load: (payload) => payload,
      loadPack: async (input) => {
        const body = input.artifacts.body;
        if (!body) throw new Error('fixture body is missing');
        return ok({ kind: 'host-blob', bytes: body.bytes });
      },
    });
    registry.configurePackIndex('/pack-index.json');
    const body = Uint8Array.of(3, 5, 8);
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('pack-index.json'))
        return new Response(
          JSON.stringify([{ guid: GUID, packageUrl: '/asset.pack.json', kind: 'host-blob' }]),
        );
      if (url.endsWith('.pack.json'))
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: GUID,
                kind: 'host-blob',
                payload: {},
                refs: [],
                artifacts: {
                  body: {
                    path: 'body.bin',
                    mediaType: 'application/octet-stream',
                    byteLength: body.byteLength,
                  },
                },
              },
            ],
          }),
        );
      return new Response(body);
    });
    vi.stubGlobal('fetch', fetcher);
    const loaded = (
      await registry.loadByGuid<{ bytes: Uint8Array }>(registry.parseGuid(GUID))
    ).unwrap();
    const adopted = registry.lookup(GUID);
    const pack = registry.packFiles.get('/asset.pack.json');
    const epoch = registry.catalogEpoch;
    expect(registry.releaseReadCaches()).toBe(1);
    expect(registry.releaseReadCaches()).toBe(0);
    expect(loaded.bytes).toEqual(body);
    expect(registry.lookup(GUID)).toBe(adopted);
    expect(registry.packFiles.get('/asset.pack.json')).toBe(pack);
    expect(registry.catalogEpoch).toBe(epoch);
    expect((await registry.loadByGuid(registry.parseGuid(GUID))).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('clears failed package and in-flight state so a retry can succeed', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'host-blob',
      load: (payload) => ({ kind: 'host-blob', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: GUID,
                packageUrl: '/asset.pack.json',
                kind: 'host-blob',
                sourcePath: 'asset',
              },
            ]),
          );
        }
        attempts += 1;
        if (attempts === 1) return new Response('missing', { status: 404 });
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              { guid: GUID, kind: 'host-blob', payload: { value: 1 }, refs: [], artifacts: {} },
            ],
          }),
        );
      }),
    );

    const first = await registry.loadByGuid(registry.parseGuid(GUID));
    expect(first.ok).toBe(false);
    const second = await registry.loadByGuid(registry.parseGuid(GUID));
    expect(second.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(registry.lookup(GUID)).toBeDefined();
  });

  it('does not expose an unresolved package as a public fast-path hit', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'host-blob',
      load: (payload) => ({ kind: 'host-blob', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: GUID,
                packageUrl: '/asset.pack.json',
                kind: 'host-blob',
                sourcePath: 'asset',
              },
            ]),
          );
        }
        await pending;
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              { guid: GUID, kind: 'host-blob', payload: { value: 1 }, refs: [], artifacts: {} },
            ],
          }),
        );
      }),
    );

    const loading = registry.loadByGuid(registry.parseGuid(GUID));
    expect(registry.lookup(GUID)).toBeUndefined();
    release?.();
    await loading;
  });

  it('re-reads the pack-index after a no-row import instead of adopting an in-flight pre-import fetch', async () => {
    let releaseImport: ((value: { ok: true }) => void) | undefined;
    let importStarted: (() => void) | undefined;
    const importCalled = new Promise<void>((resolve) => {
      importStarted = resolve;
    });
    const registry = new AssetRegistry({} as never, {
      fetchPack: () => {
        importStarted?.();
        return new Promise((resolve) => {
          releaseImport = resolve;
        });
      },
    });
    registry.loaders.register({
      kind: 'host-blob',
      load: (payload) => ({ kind: 'host-blob', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    const imported = [
      { guid: GUID, packageUrl: '/asset.pack.json', kind: 'host-blob', sourcePath: 'asset' },
    ];
    let releaseStaleIndex: (() => void) | undefined;
    let indexReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          indexReads += 1;
          const read = indexReads;
          if (read === 2) {
            await new Promise<void>((resolve) => {
              releaseStaleIndex = resolve;
            });
          }
          return new Response(JSON.stringify(read <= 2 ? [] : imported));
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              { guid: GUID, kind: 'host-blob', payload: { value: 1 }, refs: [], artifacts: {} },
            ],
          }),
        );
      }),
    );

    const loading = registry.loadByGuid(registry.parseGuid(GUID));
    await importCalled;
    // A pre-import catalog read is in flight when the import completes.
    const refreshing = registry.refreshCatalog();
    releaseImport?.({ ok: true });
    // Drain microtasks so the no-row fallback observes the still-pending read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(indexReads).toBe(2);
    releaseStaleIndex?.();

    const result = await loading;
    await refreshing;
    expect(result.ok ? 'ok' : result.error.code).toBe('ok');
    expect(indexReads).toBe(3);
    expect(registry.listCatalog().some((entry) => entry.guid === GUID)).toBe(true);
  });
});
