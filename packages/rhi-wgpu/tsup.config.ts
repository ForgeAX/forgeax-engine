import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/wasm-browser.ts', 'src/wasm-native.ts'],
  external: [
    '@forgeax/engine-rhi',
    '@forgeax/engine-types',
    '@forgeax/engine-wgpu-wasm',
    '@forgeax/engine-rhi-wgpu/wasm-runtime',
    '@webgpu/types',
  ],
});
