import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine-devkit';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url)),
  root = resolve(here, '../../..');
export default defineConfig(async ({ command }) => {
  const project = await readProjectFacts(here);
  if (!project.ok) throw project.error;
  const facts = project.value;
  const { readCurrentIdentity, validateIdentity } = await import(
    new URL('../../../scripts/forgeax/collect-ssr-dependency-report.mjs', import.meta.url).href
  );
  const identity = await readCurrentIdentity(root, 'packages/render/dist/index.mjs');
  return {
    define: {
      __WATER_R5_SSR_IDENTITY__: JSON.stringify(validateIdentity(identity).valid ? identity : null),
    },
    plugins: [
      forgeaxShader(),
      pluginPack({
        roots: [
          resolve(here, '../presentation-assets.pack.ts'),
          resolve(here, '../r5-gpu-mesh-async-pontoons/assets'),
          ...facts.assetLibraries.map((library) => library.root),
        ],
        sourceIdentityFor: (path) =>
          assetLibrarySourceIdentity(facts.assetLibraries, path) ??
          relative(facts.root, path).replaceAll('\\', '/'),
        runtimeBinding: createStandaloneRuntimeAssetBinding('water-r4-buoyancy-foam'),
        ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') },
        cookers: [createMaterialPackCooker()],
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
    server: { port: 5384, strictPort: true, fs: { allow: [root] } },
    build: { target: 'esnext' },
  };
});
