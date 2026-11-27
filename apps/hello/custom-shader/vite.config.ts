import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import wasm from '../../../packages/wgpu-wasm/pkg/provenance.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const materialCooker = createMaterialPackCooker([resolve(here, 'src')]);

export default defineConfig({
  plugins: [
    forgeaxShader(),
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('hello-custom-shader'),
      roots: [resolve(here, 'src/pulse-material.pack.json')],
      cookers: [{
        ...materialCooker,
        // This demo compares the complete portable records and their receipts.
        cacheIdentity: async () =>
          `pulse-material/record:${wasm.compilerFingerprint}:${await materialCooker.cacheIdentity?.()}`,
        cook(input) {
          const { publication: _template, ...record } = input as Record<string, unknown>;
          return materialCooker.cook({ ...record, wasm, compilerFingerprint: wasm.compilerFingerprint });
        },
      }],
      refresh: reloadAssetHost(),
    }),
  ],
  server: {
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
