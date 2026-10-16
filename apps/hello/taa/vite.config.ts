import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-taa');

export default defineConfig({
  // Keep the dev carrier inspectable through the same single-frame RHI tape
  // route used by the engine debugging workflow. Production builds define the
  // flag to "0" and tree-shake the recorder branch.
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [resolve(here, 'assets')],
      importers: [imageImporter],
      runtimeBinding,
    }),
    vitePluginRhiDebug(),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: resolve(here, 'index.html') } },
});
