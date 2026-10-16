import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  target: 'esnext',
  external: ['@forgeax/engine-rhi-debug', 'vite', 'rollup'],
});
