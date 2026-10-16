import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import type { Loader } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAssetRuntimeAssembly } from '../assets-runtime-assembly';

describe('AssetRegistry app assembly', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('assembles native package readers without acquiring browser fetch', async () => {
    const registry = new AssetRegistry({} as never);
    const readPackage = vi.fn<typeof fetch>(async () => new Response('native package'));
    const catalogSource = createCatalogSource({ entries: [], fetch: readPackage });
    vi.stubGlobal('fetch', undefined);
    try {
      const assembly = createAssetRuntimeAssembly(registry, { catalogSource }).unwrap();
      expect(readPackage).not.toHaveBeenCalled();
      const response = await registry.openPackage('graphics/example.pack.json')(
        'graphics/example.pack.json',
      );
      expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('native package');
      const retained = await assembly.fetcher('graphics/retained.pack.json');
      expect(new TextDecoder().decode(await retained.arrayBuffer())).toBe('native package');
      assembly.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('reuses the supplied Registry, installs explicit decoders, and disposes the lease', () => {
    const registry = new AssetRegistry({} as never);
    const decoder = {
      kind: 'app-test-decoder',
      load: () => ({ kind: 'app-test-asset' }),
    } as Loader<unknown>;
    const result = createAssetRuntimeAssembly(registry, {
      registry,
      catalogSource: createCatalogSource({ entries: [] }),
      decoderContributions: [decoder],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registry).toBe(registry);
    expect(registry.packIndexUrl).toBeUndefined();
    expect(registry.loaders.get(decoder.kind)).toBe(decoder);

    result.value.dispose();
    result.value.dispose();
    expect(registry.loaders.get(decoder.kind)).toBeUndefined();
    expect(registry.catalogSnapshot()).toBeUndefined();
  });

  it('keeps the default shipped source and accepts an explicit content transport', async () => {
    const registry = new AssetRegistry({} as never);
    const shipped = createAssetRuntimeAssembly(registry).unwrap();
    expect(registry.packIndexUrl).toBe('/pack-index.json');
    shipped.dispose();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('local bytes'));
    const explicit = createAssetRuntimeAssembly(registry, {
      catalogSource: createCatalogSource({ entries: [] }),
      fetcher,
    }).unwrap();
    expect(
      new TextDecoder().decode(
        await (await registry.fetchAsset('https://runtime.invalid/body')).arrayBuffer(),
      ),
    ).toBe('local bytes');
    expect(fetcher).toHaveBeenCalledTimes(1);
    explicit.dispose();
  });

  it.each([
    {},
    { baseURI: '' },
  ])('keeps the root-relative catalog for a native document shim %j', async (documentShim) => {
    vi.stubGlobal('document', documentShim);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AssetRegistry({} as never);
    const assembly = createAssetRuntimeAssembly(registry).unwrap();
    try {
      expect(await registry.refreshCatalog()).toBe(true);
      expect(registry.packIndexUrl).toBe('/pack-index.json');
      expect(assembly.catalogSource.url).toBe('/pack-index.json');
      expect(fetcher).toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([url]) => String(url) === '/pack-index.json')).toBe(true);
    } finally {
      assembly.dispose();
    }
  });

  it.each([
    ['https://shipped.invalid/', 'https://shipped.invalid/pack-index.json'],
    [
      'https://shipped.invalid/voxel-engine-volume/',
      'https://shipped.invalid/voxel-engine-volume/pack-index.json',
    ],
    [
      'https://shipped.invalid/games/example/index.html',
      'https://shipped.invalid/games/example/pack-index.json',
    ],
  ])('fetches the initial catalog relative to document base %s', async (baseURI, expectedUrl) => {
    vi.stubGlobal('document', { baseURI });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AssetRegistry({} as never);
    const assembly = createAssetRuntimeAssembly(registry).unwrap();
    try {
      expect(await registry.refreshCatalog()).toBe(true);
      expect(registry.packIndexUrl).toBe(expectedUrl);
      expect(assembly.catalogSource.url).toBe(expectedUrl);
      expect(fetcher).toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([url]) => String(url) === expectedUrl)).toBe(true);
    } finally {
      assembly.dispose();
    }
  });

  it('preserves an explicitly configured catalog under a different document base', async () => {
    vi.stubGlobal('document', { baseURI: 'https://shipped.invalid/game/' });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AssetRegistry({} as never);
    const explicitUrl = 'https://assets.invalid/custom-catalog.json';
    registry.configurePackIndex(explicitUrl);
    const assembly = createAssetRuntimeAssembly(registry).unwrap();
    try {
      expect(await registry.refreshCatalog()).toBe(true);
      expect(assembly.catalogSource.url).toBe(explicitUrl);
      expect(fetcher).toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([url]) => String(url) === explicitUrl)).toBe(true);
    } finally {
      assembly.dispose();
    }
  });

  it('returns a closed assembly error instead of creating a second Registry owner', () => {
    const rendererRegistry = new AssetRegistry({} as never);
    const injectedRegistry = new AssetRegistry({} as never);
    const result = createAssetRuntimeAssembly(rendererRegistry, { registry: injectedRegistry });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'asset-assembly-failed',
        detail: expect.objectContaining({ kind: 'registry' }),
      }),
    });
  });
});
