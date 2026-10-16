import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// learn-render section-1.5 transformations vite config.
// 1.5 covers cube + textured container + Transform animation
// (translate + Z-rotate + sin-pulse). `pluginPack()` wires the scoped dev
// catalog (configureServer middleware) and emits `/pack-index.json` at build
// time. The app's `configureRuntimeAssetCatalog` helper selects the source.
// Local assets/ holds material-wood.pack.json;
// the container.jpg image sidecar + cube-mesh.stub.meta.json sidecar
// live in the forgeax-engine-assets/learn-opengl submodule subtree
// (charter F1 single-grep + P4 consistent abstraction; 3-root shape
// aligned with 1.4 / 1.6 / 1.7).
//
// Dev port 5184 is reserved for this app; strictPort prevents collision
// with hello-triangle (default 5173) and the parity-* fleet (4173-4175).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// Publish this demo's complete asset closure, without unrelated sibling sources.
const assetRoots = [
  resolve(here, 'assets'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/meshes/cube-mesh.stub.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/container.jpg.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-1-5-transformations');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter, gltfImporter], roots: assetRoots }),
    ),
  ],
  server: {
    port: 5184,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    // R-01 guard mirroring 4.textures: the vite-plugin-pack import step
    // emits raw RGBA bytes as `assets/<guid>-<hash>.bin`; opt `.bin`
    // out of inlining regardless of size so the pack-index packageUrl
    // resolves at runtime.
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
  // M12 fixup: see 1.hello-window/vite.config.ts for the rationale.
  // transformations.browser.test.ts here must not run under the default
  // unit project (jsdom / no WebGPU / no fetch); the root `browser`
  // project still picks it up via the global `**/*.browser.test.ts` glob.
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
