import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const textureRoot = resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const runtimeBinding = createStandaloneRuntimeAssetBinding('bevy-parallax-mapping');
const assetPlugins = existsSync(textureRoot)
  ? [
      pluginPack({
        runtimeBinding,
        refresh: reloadAssetHost(),
        importers: [imageImporter],
        roots: [textureRoot],
      }),
    ]
  : [];

export default defineConfig({
  plugins: [
    forgeaxShader({ materialPackages: [resolve(here, 'src/parallax.pack.json')] }) as never,
    vitePluginRhiDebug(),
    ...assetPlugins,
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
