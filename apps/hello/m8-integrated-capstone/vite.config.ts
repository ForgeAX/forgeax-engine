import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { capstoneContentImporter } from './src/reimport';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const sfxRoot = resolve(repoRoot, 'forgeax-engine-assets', 'sfx');
const localAssets = resolve(here, 'assets');
const assetRoots = [sfxRoot, localAssets];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-m8-integrated-capstone');

export default defineConfig({
  plugins: [
    vitePluginRhiDebug(),
    forgeaxShader({ materialPackages: [resolve(here, 'src/pulse-material.pack.json')] }) as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        roots: assetRoots,
        importers: [audioImporter, capstoneContentImporter()],
        refresh: reloadAssetHost(),
        runtimeBinding,
      }),
    ),
  ],
  server: {
    port: 5208,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: (filePath: string): boolean | undefined => filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
