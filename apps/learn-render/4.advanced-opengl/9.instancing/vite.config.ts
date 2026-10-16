import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// Publish this demo's complete asset closure, without unrelated sibling sources.
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/objects/planet/mars.png.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/objects/planet/planet.gltf.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/objects/rock/rock.gltf.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/objects/rock/rock.png.meta.json'),
];

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        runtimeBinding: createStandaloneRuntimeAssetBinding('learn-render-4-9-instancing'),
        refresh: reloadAssetHost(),
        importers: [imageImporter, gltfImporter],
        roots: assetRoots,
      }),
    ),
  ],
  server: {
    port: 5180,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
