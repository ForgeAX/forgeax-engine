import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// w15 integration: inject the forgeaxShader plugin (4 hooks + ShaderError ->
// RollupLog wrap). The M2 phase validates .wgsl pass-through + the three-piece
// artifact set + manifest persistence; from M3 (D-S11) the production path
// uses pbr.wgsl exclusively - the previous fixture triangle.wgsl is removed.
// feat-20260510-smoke-architecture-redesign cash-out: smoke-dawn.mjs is now
// ECS-driven and shares the same call chain as src/main.ts (no parallel
// inline TRIANGLE_WGSL implementation; charter proposition 6 guarded by
// smoke-coverage-gate.mjs delta+zeta double-layer).
//
// build.rollupOptions.input adds pbr.wgsl (root) + view.wgsl + brdf.wgsl
// (imported siblings) to the build graph so the plugin transform fires on
// them (main.ts does not directly reference the .wgsl asset, avoiding
// pollution of hello-triangle's real render dependencies; the engine
// internally consumes the manifest produced by the plugin via
// Renderer.ready -> shader.loadManifest). T-19 split into 3 files canonical
// composition demo (view + brdf + pbr via naga_oil #import).
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
        pbr: resolve(here, 'src/shaders/pbr.wgsl'),
        view: resolve(here, 'src/shaders/view.wgsl'),
        brdf: resolve(here, 'src/shaders/brdf.wgsl'),
      },
    },
  },
});
