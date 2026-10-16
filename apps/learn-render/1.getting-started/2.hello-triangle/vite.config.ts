import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// learn-render section-1.2 hello-triangle vite config.
// 1.2 lands the first visible triangle via `world.spawn(HANDLE_TRIANGLE)`
// + Engine.create + renderer.draw(world). LO-faithful: unlit orange
// `vec4(1.0, 0.5, 0.2, 1.0)` from the LO 1.2 fragment shader literal,
// no DirectionalLight (engine v1 frag shader outputs material.baseColor
// directly).
//
// forgeaxShader() serves /shaders/manifest.json (pbr.wgsl + unlit.wgsl
// + tonemap.wgsl SSOT triple) so Engine.create({ canvas }) takes the
// default manifest path. Without this plugin the runtime emits
// `shader-compile-failed` at ready time (witness:
// .forgeax-harness/forgeax-loop/bug-20260519-engine-forces-pbr-unlit-
// shader-compile-in-clear-pas/ + the silent-lie comment in
// vitest.config.ts §browser project).
//
// Dev port 5181 is reserved for this app; strictPort prevents collision
// with hello-triangle (default 5173) and the parity-* fleet (4173-4175).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    port: 5181,
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
  // M12 fixup: see 1.hello-window/vite.config.ts for the rationale.
  // Even though this workspace currently has no browser / dawn tests
  // (1.2 reuses apps/hello/triangle smoke per D-7 / OOS-10), applying
  // the same exclude shape across all 7 section-1 workspaces keeps the
  // per-workspace unit project surface uniform (architecture principle
  // 1 SSOT: one rule, applied identically).
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
