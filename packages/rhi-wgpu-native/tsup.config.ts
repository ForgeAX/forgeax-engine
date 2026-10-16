import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  platform: 'node',
  external: [
    '@forgeax/engine-rhi',
    '@forgeax/engine-rhi-webgpu',
    '@forgeax/engine-types',
    '@webgpu/types',
  ],
});
