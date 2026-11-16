import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  splitting: true,
  entry: ['src/index.ts', 'src/internal.ts'],
});
