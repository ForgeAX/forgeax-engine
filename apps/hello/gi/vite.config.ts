import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const sponzaMeta = resolve(
  monorepoRoot,
  'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf.meta.json',
);
// Sponza lives in the contributor asset checkout; the procedural scenes never depend on it.
const sponzaRoots = existsSync(sponzaMeta) ? [sponzaMeta] : [];

export default defineConfig({
  plugins: [
    forgeaxShader({ engineEntries: { pointShadows: true } }) as never,
    vitePluginRhiDebug({ rootDir: here }) as never,
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('hello-gi'),
      refresh: reloadAssetHost(),
      roots: [resolve(here, 'assets', 'gi-materials.pack.ts'), ...sponzaRoots],
      importers: [imageImporter, gltfImporter],
      cookers: [createMaterialPackCooker()],
    }),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext' },
});
