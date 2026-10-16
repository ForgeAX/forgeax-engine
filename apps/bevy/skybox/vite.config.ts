import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const assetRoots = [resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures')];
const runtimeBinding = createStandaloneRuntimeAssetBinding('bevy-skybox');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    vitePluginRhiDebug(),
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), roots: assetRoots, importers: [imageImporter] }),
    ),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
