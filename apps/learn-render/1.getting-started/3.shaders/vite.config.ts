import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// learn-render section-1.3 shaders vite config (M4 placeholder).
// 1.3 covers a custom WGSL fragment uniform pulse demo; the M7 milestone
// (m7-app-1-3-shaders) wires `forgeaxShader()` plugin and the play.wgsl
// asset entry alongside index.html. M4 scaffolds the minimal shape so
// `pnpm -r build` does not fail.
//
// Dev port 5182 is reserved for this app; strictPort prevents collision
// with hello-triangle (default 5173) and the parity-* fleet (4173-4175).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    port: 5182,
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
  // shaders.browser.test.ts here must not run under the default unit
  // project (jsdom / no WebGPU / no fetch); the root `browser` project
  // still picks it up via the global `**/*.browser.test.ts` glob.
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
