import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/target-id.ts', 'src/animated-bounds.ts', 'src/skeletal-motion.ts', 'src/spline-ik.ts'],
  format: ['esm'],
  dts: false,
  clean: false,
  outDir: 'dist',
  sourcemap: true,
  outExtension: () => ({ js: '.mjs' }),
});
