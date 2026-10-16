import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// RHI-debug frame capture wired via the shared preset. Same vendor
// newport_loft.hdr Skylight input + pluginPack wiring as sibling 2.ibl-irradiance;
// pluginPack passed through extraPlugins so the preset owns forgeaxShader +
// vitePluginRhiDebug + fs.allow.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// Publish this demo's complete asset closure, without unrelated sibling sources.
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/newport_loft.hdr.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-6-3-ibl-specular');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5197,
  extraPlugins: [
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter], roots: assetRoots }),
    ),
  ],
});
