import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const dejavuFonts = resolve(monorepoRoot, 'forgeax-engine-assets', 'dejavu-fonts');
const legacyFontRoots = [
  resolve(dejavuFonts, 'DejaVuSansMono.atlas.png'),
  resolve(dejavuFonts, 'DejaVuSansMono.atlas.png.meta.json'),
  resolve(dejavuFonts, 'DejaVuSansMono.font.pack.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('bevy-text2d');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    vitePluginRhiDebug(),
    ...optionalAssetPack(legacyFontRoots, () =>
      pluginPack({
        runtimeBinding,
        roots: legacyFontRoots,
        importers: [imageImporter],
        refresh: reloadAssetHost(),
      }),
    ),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
