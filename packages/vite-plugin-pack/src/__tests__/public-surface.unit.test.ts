import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as catalogClientSurface from '../catalog-client.js';
import * as publicSurface from '../index.js';

const packageManifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { readonly exports: { readonly '.': { readonly browser: null } } };

describe('vite-plugin-pack public surface', () => {
  test('exposes only the two root runtime values', () => {
    expect(Object.keys(publicSurface).sort()).toEqual(['pluginPack', 'reloadAssetHost']);
    expect(typeof publicSurface.pluginPack).toBe('function');
    expect(typeof publicSurface.reloadAssetHost).toBe('function');
  });

  test('exposes only the catalog client runtime value', () => {
    expect(Object.keys(catalogClientSurface).sort()).toEqual(['createCatalogClient']);
    expect(typeof catalogClientSurface.createCatalogClient).toBe('function');
  });

  test('does not publish a browser-shaped no-op for the build-only package', () => {
    expect(packageManifest.exports['.'].browser).toBeNull();
  });
});
