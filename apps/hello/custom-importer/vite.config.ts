import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';

import { reelGameBlobImporter } from './src/reel-game-blob-importer';

// hello-custom-importer vite config -- acceptance app for
// feat-20260629-importer-self-declared-fold-contract (M5 / w15).
//
// Two-plugin stack (mirrors hello-sprite):
//   - forgeaxShader -- compiles the engine's built-in material shaders into
//     the shader manifest + emits `virtual:forgeax/bundler`.
//   - pluginPack({ roots, importers }) -- the FEAT-CRITICAL line: the host
//     importer `reelGameBlobImporter()` is injected via `importers`. At
//     `vite build` time the import runner dispatches the
//     `importer: 'reel-game-blob'` sidecar to it (P2 default passthrough --
//     no engine whitelist edit), folds the produced ImportedAsset into a DDC
//     `.pack.json`, and writes a pack-index.json row of kind 'reel-game-blob'.
//
// Assets live locally under ./assets (a host's own JSON blob + sidecar); this
// app uses NO forgeax-engine-assets submodule binary, so the smoke is fully
// self-contained.
//
// Dev port 5196 is reserved for this app (strictPort prevents collision with
// the rest of the hello-* fleet).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const localAssets = resolve(here, 'assets');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-custom-importer');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      ddc: {
        buildCacheRoot: resolve(monorepoRoot, 'shared-build-inputs', 'ddc'),
        projectDdcRoot: resolve(here, '.forgeax', 'ddc', 'v2'),
      },
      roots: [localAssets],
      importers: [reelGameBlobImporter()],
      runtimeBinding,
    }),
  ],
  server: {
    port: 5196,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
