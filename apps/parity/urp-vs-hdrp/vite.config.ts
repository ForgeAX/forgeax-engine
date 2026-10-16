import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// Standard direct-vs-clustered parity vite config.
// Single page hosting two canvases: left Standard direct, right Standard clustered.
// Preview port 4175 + strictPort=true: scripts/bench/pixel-parity.mjs uses
// this preview for the Standard lanes target (and tears it down before the
// next target when BENCH_TARGET=all).
export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  preview: {
    port: 4175,
    strictPort: true,
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
