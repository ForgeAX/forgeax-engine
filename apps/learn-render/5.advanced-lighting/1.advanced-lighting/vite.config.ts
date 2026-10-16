import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). The demo's LearnOpenGL textures are served via
// pluginPack, passed through extraPlugins so the preset still owns the shader +
// capture plugins. Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// Publish this demo's complete asset closure, without unrelated sibling sources.
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-5-1-advanced-lighting');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5175,
  keepBinExternal: true,
  materialPackages: [resolve(here, 'src/blinn-phong.pack.json')],
  extraPlugins: [
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        runtimeBinding,
        refresh: reloadAssetHost(),
        producerReadiness: 'on-demand',
        importers: [imageImporter],
        roots: assetRoots,
      }),
    ),
  ],
});
