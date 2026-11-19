import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/internal.ts'],
  splitting: true,
  // Native ESM browser hosts may disable Vite dependency discovery.
  noExternal: ['cdt2d'],
});
