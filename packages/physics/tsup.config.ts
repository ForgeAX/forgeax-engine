import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  external: [
    '@forgeax/engine-ecs',
    '@forgeax/engine-math',
    '@forgeax/engine-types',
    '@forgeax/engine-plugin',
    '@forgeax/engine-scene',
  ],
});
