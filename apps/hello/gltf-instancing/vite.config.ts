import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-gltf-instancing');

// hello-gltf-instancing vite config (feat-20260518 M5).
//
// Mirror of hello-gltf/vite.config.ts. The fixture <source>.meta.json sidecar
// (here `instanced-box.gltf.meta.json`, assetType=gltf) is
// JSON-importable from src/main.ts so the 4-step recipe reads the GUID list
// at build time without a fetch (charter P2 structured-over-prose).
export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({ runtimeBinding, roots: [resolve(here, 'assets')], importers: [imageImporter, gltfImporter], refresh: reloadAssetHost() }),
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
