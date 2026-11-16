import { relative, resolve } from 'node:path';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine/devkit';
import { imageImporter } from '@forgeax/engine/image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = import.meta.dirname;
export default defineConfig(async ({ command }) => {
  const project = await readProjectFacts(here);
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
        runtimeBinding: createStandaloneRuntimeAssetBinding('water-info-demo'),
        ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') },
        cookers: [createMaterialPackCooker()],
        importers: [imageImporter],
      }),
      ...(command === 'serve' ? [vitePluginRhiDebug()] : []),
    ],
    server: { fs: { allow: [resolve(here, '../../..')] } },
    build: { target: 'esnext', rolldownOptions: { input: resolve(here, 'src/main.ts') } },
  };
});
