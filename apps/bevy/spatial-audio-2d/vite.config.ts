import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const sfxDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'sfx');
const assetRoots = [sfxDir];
const runtimeBinding = createStandaloneRuntimeAssetBinding('bevy-spatial-audio-2d');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, roots: assetRoots, importers: [audioImporter], refresh: reloadAssetHost() }),
    ),
  ],
  server: {
    port: 5210,
    strictPort: true,
    fs: { allow: [monorepoRoot] },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
