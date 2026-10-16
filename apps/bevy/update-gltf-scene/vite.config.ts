import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { gltfImporter } from '@forgeax/engine-gltf';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('bevy-update-gltf-scene');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    vitePluginRhiDebug(),
    pluginPack({
      runtimeBinding,
      refresh: reloadAssetHost(),
      roots: [resolve(monorepoRoot, 'apps/hello/gltf/assets')],
      importers: [gltfImporter],
    }),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
