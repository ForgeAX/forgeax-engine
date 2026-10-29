import { describe, expect, it } from 'vitest';
import {
  createStandaloneRuntimeAssetBinding,
  runtimeScopePath,
} from '../src/runtime-scope';

describe('runtime scope binding', () => {
  it('derives catalog, import, and package endpoints from one identity', () => {
    const binding = createStandaloneRuntimeAssetBinding('collectathon');

    expect(binding).toMatchObject({
      schemaVersion: 'runtime-asset-binding-v1',
      gameId: 'collectathon',
      scopeId: 'collectathon',
      generation: 1,
      status: 'ready',
      catalogUrl: '/__pack/scopes/collectathon/1/catalog.json',
      importUrlBase: '/__pack/scopes/collectathon/1/import',
      packageUrlBase: '',
    });
  });

  it('supports a host prefix without changing the engine scope path', () => {
    const binding = createStandaloneRuntimeAssetBinding('preview', 'preview', '/preview/');

    expect(binding.catalogUrl).toBe('/preview/__pack/scopes/preview/1/catalog.json');
    expect(binding.importUrlBase).toBe('/preview/__pack/scopes/preview/1/import');
    expect(binding.packageUrlBase).toBe('/preview');
    expect(runtimeScopePath(binding, 'asset/example.pack.json')).toBe(
      '/__pack/scopes/preview/1/asset/example.pack.json',
    );
  });

});
