import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: false,
  outDir: 'dist',
  sourcemap: true,
  outExtension: () => ({ js: '.mjs' }),
});
