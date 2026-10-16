import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-gltf');

// hello-gltf vite config (feat-20260515-gltf-loader-via-asset-system M5).
//
// Mirror of hello-room/vite.config.ts with one extra concern: the
// <source>.meta.json sidecar (here `box.gltf.meta.json`, assetType=gltf)
// must be JSON-importable from src/main.ts so the
// 4-step recipe can read the deterministic GUID list at build time
// without a fetch (charter P2 structured-over-prose: AI users see the
// GUID -> kind mapping in the import statement, not in a string literal).
// vite handles `import * as meta from './assets/box.gltf.meta.json'`
// natively; no plugin needed.
//
// forgeaxShader is included for the same reason hello-room includes it:
// the engine ships build-time pbr/unlit shader entries via a manifest.json
// emitted by @forgeax/engine-vite-plugin-shader (feat-20260518-pbr-direct-
// lighting-mvp M5 / w22.8); the hello-gltf app consumes the manifest
// through the same RenderSystem path.
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
