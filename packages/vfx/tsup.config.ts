import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/internal.ts'],
  external: [
    '@forgeax/engine-assets-runtime',
    '@forgeax/engine-ecs',
    '@forgeax/engine-types',
  ],
});
