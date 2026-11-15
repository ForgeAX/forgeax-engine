import { relative, resolve } from 'node:path';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine-devkit';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine/vfx-compiler';
import { AssetGuid } from '@forgeax/engine/pack/source';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { defineConfig } from 'vite';
import { WATER_R8_PACKAGE, WATER_R8_SCOPE } from './src/identity';
import { WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS } from './assets/vfx/water-entry-splash-material-inputs';

const here = import.meta.dirname,
  root = resolve(here, '../../..');
export default defineConfig(async ({ command }) => {
  const result = await readProjectFacts(here);
  if (!result.ok) throw result.error;
  const facts = result.value;
  const { readCurrentIdentity, validateIdentity } = await import(
    new URL('../../../scripts/forgeax/collect-ssr-dependency-report.mjs', import.meta.url).href
  );
  const identity = await readCurrentIdentity(root, 'packages/render/dist/index.mjs');
  return {
    define: {
      __WATER_R8_SSR_IDENTITY__: JSON.stringify(validateIdentity(identity).valid ? identity : null),
    },
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
        runtimeBinding: createStandaloneRuntimeAssetBinding(WATER_R8_SCOPE),
        ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') },
        cookers: [
          createMaterialPackCooker(),
          createParticleCodeNativeCookerFromRoots([resolve(here, 'assets/vfx')], {
            [AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, 'material/water-entry-splash'))]:
              WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS,
          }),
        ],
        importers: [imageImporter],
      }),
      ...(command === 'serve'
        ? [
            vitePluginRhiDebug(
              process.env.FORGEAX_RHI_CAPTURE_ROOT
                ? { rootDir: process.env.FORGEAX_RHI_CAPTURE_ROOT }
                : {},
            ),
          ]
        : []),
    ],
    server: { host: '0.0.0.0', port: 8090, strictPort: true, fs: { allow: [root] } },
    preview: { host: '0.0.0.0', port: 8090, strictPort: true },
    build: { target: 'esnext' },
  };
});
