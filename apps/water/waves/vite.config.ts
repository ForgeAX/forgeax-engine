import { relative, resolve } from 'node:path';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine/devkit';
import { imageImporter } from '@forgeax/engine/image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine/shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
export default defineConfig(async () => {
  const project = await readProjectFacts(root);
  if (!project.ok) throw project.error;
  const facts = project.value;
  return {
    plugins: [
      forgeaxShader(),
      pluginPack({
        roots: [
          ...facts.assetRoots.map((path) => resolve(facts.root, path)),
          ...facts.assetLibraries.map((library) => library.root),
        ],
        sourceIdentityFor: (path) =>
          assetLibrarySourceIdentity(facts.assetLibraries, path) ??
          relative(facts.root, path).replaceAll('\\', '/'),
        cookers: [createMaterialPackCooker()],
        importers: [imageImporter],
        runtimeBinding: createStandaloneRuntimeAssetBinding('water-waves'),
        ddc: { projectDdcRoot: resolve(root, '.forgeax/ddc/v2') },
        refresh: reloadAssetHost(),
      }),
      vitePluginRhiDebug(),
    ],
    server: { fs: { allow: [resolve(root, '../../..')] } },
    build: { target: 'esnext', rolldownOptions: { input: resolve(root, 'src/main.ts') } },
  };
});
