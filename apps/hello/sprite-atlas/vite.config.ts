import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

// hello-sprite-atlas vite config (feat-20260521-sprite-atlas-animation M6).
//
// The atlas PNG + sidecar are pre-generated via the atlas CLI and live in
// the forgeax-engine-assets submodule under demo-assets/hello-sprite-atlas/.
// The engine repo carries zero binaries; the demo build chain has zero
// atlas-tool dependency (charter P5 producer/consumer physical separation --
// plan-decisions D-8) and requires the submodule to be initialised.
//
// Dev port 5194 is reserved for this app (strictPort prevents collision
// with hello-sprite 5193 / hello-tonemap 5173).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const demoAssets = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets', 'hello-sprite-atlas');
const assetRoots = [demoAssets];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-sprite-atlas');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, roots: assetRoots, importers: [imageImporter], refresh: reloadAssetHost() }),
    ),
  ],
  server: {
    port: 5194,
    strictPort: true,
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
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
