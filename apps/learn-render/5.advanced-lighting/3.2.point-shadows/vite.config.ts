import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). Capture stays gated behind
// FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// This demo owns one source texture. Point the Pack root at that file instead
// of the whole learn-opengl texture directory so dev/build only scans and
// publishes the asset the scene actually references.
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures', 'wood.png.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding(
  'learn-render-5-3-2-point-shadows',
);

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5200,
  engineEntries: { pointShadows: true },
  keepBinExternal: true,
  extraPlugins: [
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        runtimeBinding,
        refresh: reloadAssetHost(),
        importers: [imageImporter],
        roots: assetRoots,
      }),
    ),
  ],
});
