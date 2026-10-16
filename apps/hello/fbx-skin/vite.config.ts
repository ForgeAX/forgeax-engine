import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fbxImporter } from '@forgeax/engine-fbx';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

// hello-fbx-skin vite config (feat-20260615-fbx-importer-via-sdk M5 t51).
//
// pluginPack selects humanoid.fbx.meta.json from forgeax-engine-assets/vendor/fbx-test,
// dispatching its humanoid.fbx source to fbxImporter at build time. The runtime
// resolves the GUIDs at registry time via configureRuntimeAssetCatalog(...)
// + loadByGuid<SceneAsset>(sceneGuid) + sceneInstances.instantiate x 3 with
// per-instance AnimationPlayer for pose-distinct rendering.
//
// The .fbx fixture lives in the forgeax-engine-assets submodule per the
// engine repo's zero-binary invariant.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const assetRoots = [resolve(monorepoRoot, 'forgeax-engine-assets/vendor/fbx-test/humanoid.fbx.meta.json')];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-fbx-skin');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        runtimeBinding,
        refresh: reloadAssetHost(),
        roots: assetRoots,
        importers: [fbxImporter],
        cookers: [createMaterialPackCooker()],
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
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
