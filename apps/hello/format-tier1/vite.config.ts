import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gltfImporter } from '@forgeax/engine-gltf';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('format-tier1'),
      roots: [resolve(here, 'fixtures')],
      importers: [gltfImporter],
      refresh: reloadAssetHost(),
    }),
  ],
  server: {
    fs: { allow: [monorepoRoot] },
  },
  build: {
    target: 'esnext',
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
