import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  external: [
    '@forgeax/engine-import',
    '@forgeax/engine-types',
    '@forgeax/engine-vfx',
  ],
});
