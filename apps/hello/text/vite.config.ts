import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

// The checked-in MSDF atlas and its v3 Font Pack share the ordinary build catalog.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const dejavuFonts = resolve(monorepoRoot, 'forgeax-engine-assets', 'dejavu-fonts');
const bakedFontRoots = [
  resolve(dejavuFonts, 'DejaVuSansMono.atlas.png'),
  resolve(dejavuFonts, 'DejaVuSansMono.atlas.png.meta.json'),
  resolve(dejavuFonts, 'DejaVuSansMono.font.pack.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-text');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(bakedFontRoots, () =>
      pluginPack({ runtimeBinding, roots: bakedFontRoots, importers: [imageImporter], refresh: reloadAssetHost() }),
    ),
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
