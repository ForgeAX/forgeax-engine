import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-tonemap vite config (feat-20260519-tonemap-reinhard-mvp / M4 / T-M4.1).
// Mirrors hello-room / hello-cube vite.config.ts shape; the forgeaxShader plugin
// is required so the engine-shader manifest carries the 3rd entry (tonemap.wgsl)
// at dev time + the production build emits a self-contained shader manifest.
export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
