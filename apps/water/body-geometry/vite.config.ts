import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetLibrarySourceIdentity, readProjectFacts } from '@forgeax/engine/devkit';
import { imageImporter } from '@forgeax/engine/image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const monorepoRoot = resolve(root, '../../..');

export default defineConfig(async () => {
  const project = await readProjectFacts(root);
  if (!project.ok) throw project.error;
  const facts = project.value;
  return {
    plugins: [
      forgeaxShader(),
      pluginPack({
        roots: [
          resolve(root, 'assets'),
          resolve(root, '../terrain-provider/assets'),
          resolve(root, '../presentation-assets.pack.ts'),
          ...facts.assetLibraries.map((library) => library.root),
        ],
        sourceIdentityFor: (path) =>
          assetLibrarySourceIdentity(facts.assetLibraries, path) ??
          relative(root, path).replaceAll('\\', '/'),
        cookers: [createMaterialPackCooker()],
        importers: [imageImporter],
        runtimeBinding: createStandaloneRuntimeAssetBinding('water-body-geometry'),
        ddc: { projectDdcRoot: resolve(root, '.forgeax/ddc/v2') },
        refresh: reloadAssetHost(),
      }),
      vitePluginRhiDebug(
        process.env.FORGEAX_RHI_CAPTURE_ROOT
          ? { rootDir: process.env.FORGEAX_RHI_CAPTURE_ROOT }
          : {},
      ),
    ],
    server: { port: 5382, strictPort: true, fs: { allow: [monorepoRoot] } },
    build: { target: 'esnext' },
  };
});
