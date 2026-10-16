import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { optionalAssetPack } from '../shared/src/optional-asset-pack.js';

// collectathon vite config: 3D third-person collectathon showcase.
//
// pluginPack roots: M2 adds the humanoid.fbx fixture directory (the player
// skinned mesh, reused from apps/hello/fbx-skin per D-3). M5 adds the sky.hdr
// directory (IBL, demo-assets/template-game-default) + the collectathon-audio
// directory (footstep/pickup/guardian/BGM cues). monorepoRoot is 2 levels up
// (apps/collectathon -> monorepo root), same depth as apps/tetris, NOT the
// 3-level hello path.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets/vendor/fbx-test'),
  resolve(monorepoRoot, 'forgeax-engine-assets/demo-assets/template-game-default'),
  resolve(monorepoRoot, 'forgeax-engine-assets/collectathon-audio'),
  resolve(monorepoRoot, 'forgeax-engine-assets/dejavu-fonts'),
];

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        runtimeBinding: createStandaloneRuntimeAssetBinding('collectathon'),
        refresh: reloadAssetHost(),
        roots: assetRoots,
        importers: [audioImporter, imageImporter, gltfImporter, fbxImporter, fontImporter],
        cookers: [createMaterialPackCooker()],
      }),
    ),
  ],
  server: {
    // The local/CI smoke runs in disposable worktrees where macOS Node 26 can
    // stall while registering FSEvents during the first Vite request.  Keep
    // normal development on the native watcher, but let the smoke select the
    // deterministic polling path explicitly.
    watch:
      process.env.FORGEAX_COLLECTATHON_HMR_POLLING === '1'
        ? { usePolling: true, interval: 100 }
        : undefined,
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
