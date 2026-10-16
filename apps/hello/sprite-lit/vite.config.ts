import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// hello-sprite-lit vite config (feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w6).
//
// Single-plugin stack (procedural sprite, no asset binary; plan-decisions L-2
// "demo uses procedural sprite + hardcoded light config; no new art asset"):
//   - forgeaxShader -- compile sprite-lit.wgsl + sprite.wgsl + pbr / unlit /
//     tonemap engine entries into the manifest. sprite-lit is auto-picked
//     up by vite-plugin-shader's loadEngineShaderEntries (w4).
//
// Dev port 5194 (next free after hello-sprite 5193 + the learn-render fleet
// 5180-5189 + hello-tonemap 5173).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    port: 5194,
    strictPort: true,
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
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
