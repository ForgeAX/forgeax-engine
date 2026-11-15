import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: true,
  // Native ESM browser hosts may disable Vite dependency discovery.
  noExternal: ['cdt2d'],
  outExtension: () => ({ js: '.mjs' }),
});
