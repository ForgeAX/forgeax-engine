import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine/devkit';
import { imageImporter } from '@forgeax/engine/image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { createMaterialPackCooker, createTextureGeneratorPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig(async ({ command }) => {
  const project = await readProjectFacts(here);
  if (!project.ok) throw project.error;
  const facts = project.value;
  return {
    plugins: [
      forgeaxShader(),
      pluginPack({
        roots: [
          resolve(here, 'assets/water-mesh.pack.ts'),
          resolve(here, '../presentation-assets.pack.ts'),
          ...facts.assetLibraries.map((library) => library.root),
        ],
        sourceIdentityFor: (path) =>
          assetLibrarySourceIdentity(facts.assetLibraries, path) ??
          relative(here, path).replaceAll('\\', '/'),
        importers: [imageImporter],
        runtimeBinding: createStandaloneRuntimeAssetBinding('water-mesh-demo'),
        ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') },
        cookers: [createMaterialPackCooker(), createTextureGeneratorPackCooker()],
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
    server: { port: 5383, strictPort: true, fs: { allow: [resolve(here, '../../..')] } },
    build: { target: 'esnext' },
  };
});
