import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverPluginAssets,
  executionWorkerEntries,
  pluginProgramsBuild,
  pluginRuntimeProjection,
  publishedPluginInventory,
} from '@forgeax/engine-devkit/plugin-build';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { defineConfig } from 'vite';
import { collectAssetDeclarationRoots } from './src/template-asset-roots';

const here = fileURLToPath(new URL('.', import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const emptyAssetRoot = resolve(monorepoRoot, 'templates', 'empty', 'assets');
const previewUiAuthoringMetaPath = resolve(
  here,
  'assets',
  'ui-authoring',
  'preview-hud.ui.html.meta.json',
);

// The UI authoring smoke validates the authoring gateway and capture lifecycle,
// not the full game-default asset closure. Keep that contract real while
// giving it the smallest deterministic Pack/shader graph: the empty template
// scene plus the catalogued UI source. The full Preview template smoke remains
// the owner for the default game's complete renderer/catalog closure.
const roots = [
  ...collectAssetDeclarationRoots(emptyAssetRoot),
  previewUiAuthoringMetaPath,
];

export default defineConfig(async () => {
  const runtimeBinding = createStandaloneRuntimeAssetBinding('preview');
  const pack = pluginPack({
    runtimeBinding,
    refresh: reloadAssetHost(),
    roots,
    importers: [createUiImporter()],
    ddc: {
      buildCacheRoot: resolve(monorepoRoot, 'shared-build-inputs', 'ddc'),
      projectDdcRoot: resolve(here, '.forgeax', 'ddc', 'ui-authoring'),
    },
  });
  const manifests = [
    ['game-capability-lab', 'apps/game-capability-lab/forge.json'],
    ['depth-of-field', 'apps/game-capability-lab/depth-of-field.forge.json'],
    ['brotato-3d', 'apps/showcase/brotato-3d/forge.json'],
    ['empty', 'templates/empty/forge.json'],
    ['game-3d', 'templates/game-3d/forge.json'],
  ] as const;
  const programPlugins = await Promise.all(
    manifests.map(async ([namespace, path]) => {
      const projectRoot = resolve(monorepoRoot, path, '..');
      const selected = namespace === 'empty';
      const manifest = selected
        ? JSON.parse(await readFile(resolve(monorepoRoot, path), 'utf8'))
        : { roots: {} };
      const inventory = selected
        ? await discoverPluginAssets({ root: projectRoot, assetRoots: ['assets'] })
        : { assets: new Map(), sourceInputs: new Map(), deferred: [] };
      return pluginProgramsBuild({
        namespace,
        projectRoot,
        roots: manifest.roots,
        tools: [],
        inventory: () => publishedPluginInventory(projectRoot, inventory, pack),
        binding: runtimeBinding,
        pack,
      });
    }),
  );

  return {
    optimizeDeps: {
      noDiscovery: true,
      include: ['@forgeax/engine-ui/authoring', '@forgeax/engine-ui/importer'],
    },
    plugins: [
      executionWorkerEntries(),
      // The app entry imports this virtual module even when the renderer falls
      // back. Keep the canonical shader plugin as its producer, but skip the
      // eager engine shader suite and authored material scan for this focused
      // authoring carrier.
      forgeaxShader({ engineEntries: false, publishAuthoredMaterialShaders: false }),
      pack,
      pluginRuntimeProjection(),
      ...programPlugins,
    ],
    server: {
      fs: { allow: [monorepoRoot] },
    },
  };
});
