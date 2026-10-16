import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/cli-fbx.ts'],
  external: ['../pkg/fbx-wasm.mjs', '@forgeax/engine-import'],
});
