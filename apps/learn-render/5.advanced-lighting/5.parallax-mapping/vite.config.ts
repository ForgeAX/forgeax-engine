import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
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
// Publish the two complete texture sets consumed by this demo.
const assetRoots = [
  'bricks2.jpg', 'bricks2_normal.jpg', 'bricks2_disp.jpg',
  'toy_box_diffuse.png', 'toy_box_normal.png', 'toy_box_disp.png',
].map((file) => resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures', `${file}.meta.json`));
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-5-5-parallax-mapping');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5189,
  keepBinExternal: true,
  materialPackages: [resolve(here, 'src/parallax.pack.json')],
  extraPlugins: [
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter], roots: assetRoots }),
    ),
  ],
});
