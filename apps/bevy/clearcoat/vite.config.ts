import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('bevy-clearcoat');
const externalRoot = resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures');
const assetRoots = [resolve(here, 'assets'), ...(existsSync(externalRoot) ? [externalRoot] : [])];

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    vitePluginRhiDebug(),
    pluginPack({ runtimeBinding, refresh: reloadAssetHost(), roots: assetRoots, importers: [imageImporter], cookers: [createMaterialPackCooker([resolve(here, 'assets')])] }),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
