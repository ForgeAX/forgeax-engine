import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: { index: 'src/index.ts' },
  external: ['@forgeax/engine-ecs', '@forgeax/engine-plugin'],
});
