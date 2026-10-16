import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

// hello-text vite config (feat-20260531 + tweak-20260610).
//
// pluginPack roots: forgeax-engine-assets/dejavu-fonts/ ships pre-baked MSDF
// artifacts (DejaVuSansMono.atlas.png + .atlas.png.meta.json + .font.pack.json)
// per tweak-20260610-hello-text-real-msdf-bake D-3 strategy B (offline bake +
// commit baked artifacts; node has no Web Worker so runtime fontImporter is
// not viable). build-catalog folds the pair into a hashed atlas .bin row +
// internal-text-package font row; runtime loadFontAsset reads atlasGuid /
// samplerGuid / glyphs / common straight from the font.pack.json payload.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const dejavuFonts = resolve(monorepoRoot, 'forgeax-engine-assets', 'dejavu-fonts');
const legacyFontRoots = [
  resolve(dejavuFonts, 'DejaVuSansMono.atlas.png'),
  resolve(dejavuFonts, 'DejaVuSansMono.atlas.png.meta.json'),
  resolve(dejavuFonts, 'DejaVuSansMono.font.pack.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-text');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    // Keep this legacy-only oracle on the checked-in pack. The sibling TTF
    // importer belongs to game-default/Preview and must not be silently
    // discovered by a demo that has not registered the font plugin.
    ...optionalAssetPack(legacyFontRoots, () =>
      pluginPack({ runtimeBinding, roots: legacyFontRoots, importers: [imageImporter], refresh: reloadAssetHost() }),
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
