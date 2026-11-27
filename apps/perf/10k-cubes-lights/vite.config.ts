import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  // Resolve emitted WASM beside the bundle in both the browser and Dawn.
  base: './',
  plugins: [forgeaxShader() as never],
  server: {
    fs: { allow: [monorepoRoot] },
  },
  build: {
    target: 'esnext',
    // The native Dawn host reads the emitted WASM and its provenance as files.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        three: resolve(here, 'three.html'),
      },
    },
  },
});
