import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-tilemap-object-layer vite config (feat-20260608 M3). Mirrors the
// hello-tilemap M0 baseline so the multi-cell + flip x pivot + per-entity
// Y-sort + multi-atlas demo exercises the same shader-pipeline path
// (charter P4 consistent abstraction); the 5 sub-scenes live in
// src/main.ts.
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
