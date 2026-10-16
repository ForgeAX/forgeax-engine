import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). The demo's textures/meshes are served via
// pluginPack, passed through extraPlugins so the preset still owns the shader +
// capture plugins. Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// Publish this demo's complete asset closure, without unrelated sibling sources.
const assetRoots = [
  resolve(here, 'assets'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/meshes/cube-mesh.stub.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/container2.png.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/container2_specular.png.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-2-4-lighting-maps');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5193,
  extraPlugins: [
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter, gltfImporter], roots: assetRoots }),
    ),
  ],
});
