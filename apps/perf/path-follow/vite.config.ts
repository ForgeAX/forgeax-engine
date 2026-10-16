import { resolve } from 'node:path';
import { executionWorkerEntries } from '@forgeax/engine-devkit/plugin-build';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import rhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
export default defineConfig(({ mode }) => ({
  plugins: [
    executionWorkerEntries(),
    forgeaxShader(),
    pluginPack({
      roots: [resolve(root, 'assets')],
      runtimeBinding: createStandaloneRuntimeAssetBinding('path-follow'),
      ddc: { projectDdcRoot: resolve(root, '.forgeax/ddc/v2') },
      refresh: reloadAssetHost(),
    }),
    ...(mode === 'capture' ? [] : [rhiDebug()]),
  ],
  // An explicit evidence build keeps the existing App recorder flag. It still
  // uses production Pack delivery; ordinary production builds erase recording.
  ...(mode === 'capture'
    ? { define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': JSON.stringify('1') } }
    : {}),
  server: { fs: { allow: [resolve(root, '../../..')] } },
  build: {
    target: 'esnext',
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        main: resolve(root, 'index.html'),
        worker: resolve(root, 'worker.html'),
        'path-bootstrap': resolve(root, 'src/worker-bootstrap.ts'),
      },
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
}));
