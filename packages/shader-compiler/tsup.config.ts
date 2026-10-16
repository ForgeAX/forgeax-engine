import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // index main entry re-exports errors / reflection; tsup walks the dependency graph and auto-compiles submodules.
  entry: ['src/index.ts'],
  // top-level await + wasm-bindgen ESM loading (plan-strategy §S-5) requires esnext target.
  target: 'esnext',
  external: [
    '@forgeax/engine-naga',
    '@forgeax/engine-shader',
    '@forgeax/engine-types',
    '@webgpu/types',
  ],
});
