import { resolve } from 'node:path';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';
const here = import.meta.dirname,
  root = resolve(here, '../../..');
export default defineConfig(({ command }) => ({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('hello-terrain'),
      roots: [
        resolve(here, 'assets/terrain.pack.ts'),
        resolve(here, 'assets/material-id.pack.ts'),
        resolve(here, 'assets/shadow-receiver.pack.ts'),
      ],
      ddc: {
        buildCacheRoot: resolve(root, 'shared-build-inputs/ddc'),
        projectDdcRoot: resolve(here, '.forgeax/ddc/v2'),
      },
      cookers: [createMaterialPackCooker()],
    }),
    ...(command === 'serve' ? [vitePluginRhiDebug()] : []),
  ],
  optimizeDeps: { noDiscovery: true },
  server: { fs: { allow: [root] } },
  build: {
    target: 'esnext',
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        index: resolve(here, 'index.html'),
        'terrain-bootstrap': resolve(here, 'src/worker-bootstrap.ts'),
        'terrain-engine-bootstrap': resolve(here, 'src/engine-only-bootstrap.ts'),
      },
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
}));
