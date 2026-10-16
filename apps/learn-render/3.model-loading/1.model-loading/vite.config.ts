import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// learn-render section-3.1 model-loading vite config.
// Sponza atrium demo with 4 PointLight + DirectionalLight +
// Skylight IBL. pluginPack scans two roots: khronos-gltf-samples for
// the Sponza glTF + 69 textures, and the explicit learn-opengl source for the
// newport_loft.hdr Skylight equirect input (CC BY-NC 4.0 carve-out).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/newport_loft.hdr.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-3-1-model-loading');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        runtimeBinding,
        refresh: reloadAssetHost(),
        roots: assetRoots,
        importers: [imageImporter, gltfImporter],
      }),
    ),
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    // Imported textures are emitted as GPU .bin payloads; skip gzip-size reporting.
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
