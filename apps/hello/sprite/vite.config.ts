import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

// hello-sprite vite config (feat-20260520-2d-sprite-layer-mvp / M-4 / w28).
//
// Two-plugin stack mirrors the learn-render-1.4-textures shape:
//   - forgeaxShader -- compile sprite.wgsl + tonemap.wgsl + pbr.wgsl +
//     unlit.wgsl into the engine shader manifest (build-time naga_oil
//     composer ; same registration path as every other demo).
//   - pluginPack    -- emit a scoped dev catalog (and /pack-index.json for
//     build generateBundle) so AssetRegistry.loadByGuid<TextureAsset>()
//     resolves the wood-container handle uniformly across dev / prod.
//
// Assets live in the forgeax-engine-assets submodule under
// demo-assets/hello-sprite/ (wood-container.jpg + sidecar). The engine repo
// carries zero binaries; `pnpm --filter @forgeax/hello-sprite dev` requires
// the submodule to be initialised (`git submodule update --init`).
//
// Dev port 5193 is reserved for this app (strictPort prevents collision
// with hello-tonemap 5173 default + the learn-render fleet 5180-5189).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const demoAssets = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets', 'hello-sprite');
const assetRoots = [demoAssets];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-sprite');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, roots: assetRoots, importers: [imageImporter], refresh: reloadAssetHost() }),
    ),
  ],
  server: {
    port: 5193,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    // R-01 guard (mirrors learn-render-1.4-textures): vite-plugin-pack
    // emits the imported RGBA bytes as `assets/<guid>-<hash>.bin`. Rollup's
    // default `build.assetsInlineLimit` (4 KiB) would inline anything
    // below the threshold -> the pack-index packageUrl would point at
    // a non-existent file, breaking runtime fetch. The callback opts
    // .bin out of inlining regardless of size.
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
