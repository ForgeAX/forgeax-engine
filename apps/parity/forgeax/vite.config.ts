import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// parity-forgeax vite config — dual-hook fixture for the pixel-parity bench.
// Provides both __captureLeft and __captureRight from the same ForgeaX renderer.
//
// Preview port 4174 + strictPort=true: scripts/bench/pixel-parity.mjs spawns
// this single preview and reads both capture hooks from it.
//
// The forgeaxShader plugin is injected so the build emits the manifest.json
// with pbr/unlit entries via @forgeax/engine-vite-plugin-shader (the case
// C unlit path per D-P5 consumes the unlit entry; feat-20260518-pbr-
// direct-lighting-mvp M5 / w22.8 retired the inline fallback shader path).
// The fixture itself ships no .wgsl source.
export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  preview: {
    port: 4174,
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
