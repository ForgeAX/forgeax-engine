import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-4-3-blending');
const learnOpenGlTexturesRoot = resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const learnOpenGlTextureRoots = [
  resolve(learnOpenGlTexturesRoot, 'metal.png.meta.json'),
  resolve(learnOpenGlTexturesRoot, 'marble.jpg.meta.json'),
  resolve(learnOpenGlTexturesRoot, 'grass.png.meta.json'),
  resolve(learnOpenGlTexturesRoot, 'window.png.meta.json'),
];

export default defineConfig({
  plugins: [
    forgeaxShader({ materialPackages: [resolve(here, 'src/alpha-test.pack.json')] }) as never,
    ...optionalAssetPack(learnOpenGlTextureRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter], roots: learnOpenGlTextureRoots }),
    ),
  ],
  server: {
    port: 5176,
    strictPort: true,
    // The shared-input HMR probe deliberately runs against a disposable dev
    // server.  macOS FSEvents can miss a single atomic WGSL replacement in a
    // cold temporary worktree (Node 26 + Vite 8), so that probe opts into the
    // deterministic watcher path without changing normal app development.
    watch:
      process.env.FORGEAX_SHARED_INPUTS_HMR_POLLING === '1'
        ? { usePolling: true, interval: 100 }
        : undefined,
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
