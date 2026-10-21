import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverPluginAssets,
  executionWorkerEntries,
  pluginProgramsBuild,
  pluginRuntimeProjection,
} from '@forgeax/engine-devkit/plugin-build';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

// hello-skin vite config (tweak-20260611-skin-fox-3clip-and-kb-sample-assets M6).
//
// pluginPack scans forgeax-engine-assets/khronos-gltf-samples/Fox so the
// build-time gltfImporter emits all 8 sub-asset PODs (mesh + material +
// scene + texture + skeleton + skin + 3 animation-clip) declared in
// Fox.glb.meta.json. The runtime resolves them at registry time via
// configureRuntimeAssetCatalog(assets, runtimeBinding) + loadByGuid<SceneAsset>(sceneGuid).
//
// forgeaxShader emits manifest.json with default-standard-pbr +
// default-standard-pbr-skin entries; the engine registers the skin variant
// at boot so any node carrying Skin renders through the skinned PBR pipeline.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Fox'),
  resolve(here, 'assets/skeletal-motion.pack.ts'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-skin');

export default defineConfig(async () => {
  const inventory = await discoverPluginAssets({ root: here, assetRoots: ['assets'] });
  const pack = pluginPack({
    runtimeBinding,
    producerReadiness: 'on-demand',
    refresh: reloadAssetHost(),
    roots: assetRoots,
    importers: [imageImporter, gltfImporter],
    cookers: [createMaterialPackCooker([resolve(here, 'assets')])],
  });
  const namespace = PackageId.parse('019fb265-1819-7000-8000-000000000001');
  if (!namespace.ok) throw namespace.error;
  const motion = AssetGuid.format(AssetGuid.derive(namespace.value, 'motion'));
  return {
    plugins: [
      forgeaxShader() as never,
      executionWorkerEntries([]),
      ...optionalAssetPack(assetRoots, () => pack),
      pluginRuntimeProjection(here, inventory.sourceInputs),
      pluginProgramsBuild({
        projectRoot: here,
        roots: { engine: motion },
        tools: [],
        inventory: () => discoverPluginAssets({ root: here, assetRoots: ['assets'] }),
        binding: runtimeBinding,
        pack,
      }),
    ],
    server: {
      fs: {
        allow: [monorepoRoot],
      },
    },
    build: {
      target: 'esnext',
      modulePreload: false,
      rollupOptions: {
        preserveEntrySignatures: 'strict',
        output: { entryFileNames: 'assets/[name].js' },
        input: {
          main: resolve(here, 'index.html'),
          skeletalMotion: resolve(here, 'skeletal-motion.html'),
          skeletalMotionWorker: resolve(here, 'skeletal-motion-worker.html'),
          'skeletal-motion-bootstrap': resolve(here, 'src/skeletal-motion-worker-bootstrap.ts'),
          'skeletal-motion-native': resolve(here, 'src/skeletal-motion-native-entry.ts'),
        },
      },
    },
  };
});
