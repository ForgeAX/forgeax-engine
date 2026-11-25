import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine/devkit';
import { imageImporter } from '@forgeax/engine/image/image-importer';
import { AssetGuid } from '@forgeax/engine/pack/source';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine/vfx-compiler';
import { createMaterialPackCooker, createTextureGeneratorPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';
import { WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS } from '../r8-integration-acceptance/assets/vfx/water-entry-splash-material-inputs';
import { WATER_R8_PACKAGE } from '../r8-integration-acceptance/src/identity';

const here = fileURLToPath(new URL('.', import.meta.url)),
  showcase = resolve(here, '../r8-integration-acceptance');
export default defineConfig(async ({ command }) => {
  const project = await readProjectFacts(here);
  if (!project.ok) throw project.error;
  const facts = project.value;
  return {
    plugins: [
      forgeaxShader(),
      pluginPack({
        roots: [
          resolve(showcase, 'assets/coast.pack.ts'),
          resolve(here, '../presentation-assets.pack.ts'),
          ...facts.assetLibraries.map((library) => library.root),
        ],
        sourceIdentityFor: (path) =>
          assetLibrarySourceIdentity(facts.assetLibraries, path) ??
          relative(here, path).replaceAll('\\', '/'),
        importers: [imageImporter],
        runtimeBinding: createStandaloneRuntimeAssetBinding('water-r8-entry-experiment'),
        ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') },
        cookers: [
          createMaterialPackCooker(),
          createTextureGeneratorPackCooker(),
          createParticleCodeNativeCookerFromRoots([resolve(showcase, 'assets/vfx')], {
            [AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, 'material/water-entry-splash'))]:
              WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS,
          }),
        ],
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
    server: { port: 5388, strictPort: true, fs: { allow: [resolve(here, '../../..')] } },
    build: { target: 'esnext' },
  };
});
