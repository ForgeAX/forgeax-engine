import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gltfImporter } from '@forgeax/engine-gltf';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-lod-occlusion');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      runtimeBinding,
      roots: [resolve(here, 'assets')],
      importers: [gltfImporter],
      refresh: reloadAssetHost(),
    }),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
