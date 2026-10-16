import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    'wasm-browser': 'src/wasm-browser.ts',
    native: 'src/native.ts',
  },
  external: [
    '@forgeax/engine-physics-rapier2d/wasm-runtime',
    '../pkg/rapier-native.mjs',
    '../pkg/rapier.mjs',
    '@forgeax/engine-ecs',
    '@forgeax/engine-math',
    '@forgeax/engine-physics',
    '@forgeax/engine-types',
  ],
});
