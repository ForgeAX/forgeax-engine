import { resolve } from 'node:path';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = import.meta.dirname;
const root = resolve(here, '../../..');

export default defineConfig(({ command }) => ({
  plugins: [
    forgeaxShader(),
    pluginPack({
      roots: [resolve(here, 'assets/terrain-provider.pack.ts')],
      runtimeBinding: createStandaloneRuntimeAssetBinding('water-terrain-provider'),
      ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') },
      cookers: [createMaterialPackCooker()],
    }),
    ...(command === 'serve' ? [vitePluginRhiDebug()] : []),
  ],
  server: { fs: { allow: [root] } },
  build: { target: 'esnext' },
}));
