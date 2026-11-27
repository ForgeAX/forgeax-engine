import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/http-artifact.ts'],
  target: 'esnext',
  external: ['@forgeax/engine-pack', 'vite', 'rollup'],
});
