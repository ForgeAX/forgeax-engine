import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/errors.ts'],
  external: ['@forgeax/engine-types', '@webgpu/types'],
});
