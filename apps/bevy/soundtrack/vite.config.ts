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
const audioDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'collectathon-audio');
const learnOpenGlAudioDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'audio');
const assetRoots = [audioDir, learnOpenGlAudioDir];
const runtimeBinding = createStandaloneRuntimeAssetBinding('bevy-soundtrack');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, roots: assetRoots, importers: [audioImporter], refresh: reloadAssetHost() }),
    ),
  ],
  server: {
    port: 5209,
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
