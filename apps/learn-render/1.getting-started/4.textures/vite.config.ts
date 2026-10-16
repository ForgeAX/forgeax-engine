import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// learn-render section-1.4 textures vite config.
// 1.4 covers disk JPEG + sidecar meta + GPU upload via loadByGuid. The
// `pluginPack()` wires the scoped dev catalog (configureServer middleware)
// and emits `/pack-index.json` at build time. The app's
// `configureRuntimeAssetCatalog` helper selects the matching source in each
// mode (charter P4 consistent abstraction).
// Local assets/ holds material-wood.pack.json; the container.jpg image
// sidecar + cube-mesh.stub.meta.json sidecar live in the
// forgeax-engine-assets/learn-opengl submodule subtree (charter F1
// single-grep + P4 consistent abstraction; 4 section vite configs share
// the 3-root shape).
//
// Dev port 5183 is reserved for this app; strictPort prevents collision
// with hello-triangle (default 5173) and the parity-* fleet (4173-4175).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// Publish this demo's complete asset closure, without unrelated sibling sources.
const assetRoots = [
  resolve(here, 'assets'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/meshes/cube-mesh.stub.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/container.jpg.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-1-4-textures');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter, gltfImporter], roots: assetRoots }),
    ),
  ],
  server: {
    port: 5183,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    // R-01 guard: the vite-plugin-pack import step emits raw RGBA bytes
    // as `assets/<guid>-<hash>.bin`. Rollup's default
    // `build.assetsInlineLimit` (4 KiB) would inline anything below the
    // threshold (e.g. a future 32x32 atlas) -> the pack-index `packageUrl`
    // would point at a non-existent file, breaking runtime fetch.
    // The callback here actively opts `.bin` out of inlining regardless
    // of size, mirroring plan-strategy section 4 R-01.
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
  // M12 fixup: see 1.hello-window/vite.config.ts for the rationale.
  // textures.browser.test.ts + textures-srgb.dawn.test.ts here must not
  // run under the default unit project (jsdom / no WebGPU / no fetch);
  // the root `browser` / `dawn` projects still pick them up via their
  // global include globs.
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
