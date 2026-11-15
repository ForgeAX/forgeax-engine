import { resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const monorepoRoot = resolve(root, '../../..');

export default defineConfig({
  plugins: [
    forgeaxShader(),
    pluginPack({
      roots: [resolve(root, 'assets')],
      runtimeBinding: createStandaloneRuntimeAssetBinding('water-body-geometry'),
      ddc: { projectDdcRoot: resolve(root, '.forgeax/ddc/v2') },
      refresh: reloadAssetHost(),
    }),
    vitePluginRhiDebug(),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext' },
});
