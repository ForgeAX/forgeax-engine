import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
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

  test('exposes the build and serve hooks through the public factory', () => {
    const plugin = publicSurface.pluginPack({ roots: [] });
    expect(plugin).toMatchObject({
      name: 'forgeax:pack',
      configureServer: expect.any(Function),
      generateBundle: expect.any(Function),
      closeBundle: expect.any(Function),
    });
  });

  test('keeps the entry as a composition root', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source.split('\n').length - 1).toBeLessThanOrEqual(1500);
    for (const owner of ['ddc-cache.js', 'package-finalizer.js', 'producer/', 'material/'])
      expect(source).not.toContain(`from './${owner}`);
  });

  test('publishes the Catalog HTTP producer through the build-only root', () => {
    expect(packageManifest.exports).not.toHaveProperty('./catalog-client');
  });

  test('does not publish a browser-shaped no-op for the build-only package', () => {
    expect(packageManifest.exports['.'].browser).toBeNull();
  });
});
