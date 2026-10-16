import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  configureRuntimeAssetCatalog,
  DEFAULT_RUNTIME_PACK_INDEX_URL,
  type RuntimeAssetCatalogOwner,
} from '../asset-runtime-config';

function createOwner(calls: string[]): RuntimeAssetCatalogOwner {
  return {
    configurePackIndex(url) {
      calls.push(`pack:${url}`);
    },
    configureRuntimeBinding(binding) {
      calls.push(`runtime:${binding.catalogUrl}`);
    },
  };
}

describe('configureRuntimeAssetCatalog', () => {
  const binding = createStandaloneRuntimeAssetBinding('catalog-test');

  it('selects the scoped runtime catalog in development', () => {
    const calls: string[] = [];

    configureRuntimeAssetCatalog(createOwner(calls), binding, { isDevelopment: true });

    expect(calls).toEqual([`runtime:${binding.catalogUrl}`]);
  });

  it('selects the emitted static catalog in production', () => {
    const calls: string[] = [];

    configureRuntimeAssetCatalog(createOwner(calls), binding, { isDevelopment: false });

    expect(calls).toEqual([
      `runtime:${binding.catalogUrl}`,
      `pack:${DEFAULT_RUNTIME_PACK_INDEX_URL}`,
    ]);
  });

  it('allows a host-specific static catalog URL', () => {
    const calls: string[] = [];

    configureRuntimeAssetCatalog(createOwner(calls), binding, {
      isDevelopment: false,
      packIndexUrl: '/games/example/pack-index.json',
    });

    expect(calls).toEqual([`runtime:${binding.catalogUrl}`, 'pack:/games/example/pack-index.json']);
  });

  it('resolves the default static catalog relative to the document base', () => {
    const calls: string[] = [];
    vi.stubGlobal('document', { baseURI: 'https://example.test/game/' });

    configureRuntimeAssetCatalog(createOwner(calls), binding, { isDevelopment: false });

    expect(calls).toEqual([
      `runtime:${binding.catalogUrl}`,
      'pack:https://example.test/game/pack-index.json',
    ]);
    vi.unstubAllGlobals();
  });

  it('fails fast when a dev binding is unavailable', () => {
    const calls: string[] = [];

    expect(() =>
      configureRuntimeAssetCatalog(createOwner(calls), undefined, { isDevelopment: true }),
    ).toThrow('runtime binding is required in development');

    expect(calls).toEqual([]);
  });
});
