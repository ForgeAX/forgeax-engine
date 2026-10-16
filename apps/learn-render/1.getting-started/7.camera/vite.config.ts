import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// learn-render section-1.7 camera vite config.
// 1.7 covers first-person WASD + mouse yaw/pitch + scroll-wheel FoV
// zoom via @forgeax/engine-input atop a 10 textured cube scene (LO 7.3
// `cubePositions[]` carried verbatim, container.jpg sRGB material). The
// `pluginPack()` wires the scoped dev catalog (configureServer middleware)
// and emits `/pack-index.json` at build time. The app's
// `configureRuntimeAssetCatalog` helper selects the source. Local assets/
// holds material-container.pack.json; the container.jpg sidecar
// + cube-mesh.stub.meta.json sidecar live in the forgeax-engine-assets/
// learn-opengl submodule subtree (charter F1 single-grep + P4
// consistent abstraction).
//
// Dev port 5186 is reserved for this app; strictPort prevents collision
// with hello-triangle (default 5173) and the parity-* fleet (4173-4175).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
// Publish this demo's complete asset closure, without unrelated sibling sources.
const assetRoots = [
  resolve(here, 'assets'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/meshes/cube-mesh.stub.meta.json'),
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/container.jpg.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-1-7-camera');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter, gltfImporter], roots: assetRoots }),
    ),
  ],
  server: {
    port: 5186,
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
  // camera.browser.test.ts + camera-input.dawn.test.ts here must not
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
