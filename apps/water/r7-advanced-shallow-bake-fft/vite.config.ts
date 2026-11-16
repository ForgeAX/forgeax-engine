import { relative, resolve } from 'node:path';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine-devkit';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { defineConfig } from 'vite';
import { WATER_R7_SCOPE } from './src/identity';

const here = import.meta.dirname, root = resolve(here, '../../..');
export default defineConfig(async ({ command }) => {
  const project = await readProjectFacts(here);
  if (!project.ok) throw project.error;
  const facts = project.value;
  const { readCurrentIdentity, validateIdentity } = await import(new URL('../../../scripts/forgeax/collect-ssr-dependency-report.mjs', import.meta.url).href);
  const identity = await readCurrentIdentity(root, 'packages/render/dist/index.mjs');
  return {
    define: { __WATER_R7_SSR_IDENTITY__: JSON.stringify(validateIdentity(identity).valid ? identity : null) },
    plugins: [forgeaxShader(), pluginPack({
      roots: [...facts.assetRoots.map(path => resolve(facts.root, path)), ...facts.assetLibraries.map(library => library.root)],
      sourceIdentityFor: path => assetLibrarySourceIdentity(facts.assetLibraries, path) ?? relative(facts.root, path).replaceAll('\\', '/'),
      runtimeBinding: createStandaloneRuntimeAssetBinding(WATER_R7_SCOPE),
      ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') }, cookers: [createMaterialPackCooker()], importers: [imageImporter],
    }), ...(command === 'serve' ? [vitePluginRhiDebug(process.env.FORGEAX_RHI_CAPTURE_ROOT ? { rootDir: process.env.FORGEAX_RHI_CAPTURE_ROOT } : {})] : [])],
    server: { port: 5387, strictPort: true, fs: { allow: [root] } }, build: { target: 'esnext' },
  };
});
