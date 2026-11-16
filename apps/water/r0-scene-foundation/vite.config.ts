import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig(({ command }) => ({
  plugins: [
    forgeaxShader(),
    pluginPack({
      roots: [
        resolve(here, 'assets/foundation.pack.ts'),
        resolve(here, '../presentation-assets.pack.ts'),
      ],
      runtimeBinding: createStandaloneRuntimeAssetBinding('water-r0-scene-foundation'),
      ddc: { projectDdcRoot: resolve(here, '.forgeax/ddc/v2') },
      cookers: [createMaterialPackCooker()],
    }),
    ...(command === 'serve'
      ? [
          vitePluginRhiDebug(
            process.env.FORGEAX_RHI_CAPTURE_ROOT
              ? { rootDir: process.env.FORGEAX_RHI_CAPTURE_ROOT }
              : {},
          ),
        ]
      : []),
  ],
  server: { port: 5380, strictPort: true, fs: { allow: [resolve(here, '../../..')] } },
  build: { target: 'esnext' },
}));
