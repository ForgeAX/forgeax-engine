import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// learn-render section-1.1 hello-window vite config.
// Engine.create still loads the built-in shader manifest during backend
// initialization, so this smallest consumer must serve the shared manifest.
//
// Dev port 5180 is reserved for this app; strictPort prevents collision
// with hello-triangle (default 5173) and the parity-* fleet (4173-4175).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    port: 5180,
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
  // M12 fixup: this workspace registers as a per-package vitest project
  // through the root vitest.config.ts D-6 dual-segment glob
  // (`apps/learn-render/1.getting-started/*/vite.config.ts`). That project
  // runs in the default node/jsdom environment, where neither
  // `navigator.gpu` nor `fetch` exists, so any `*.browser.test.ts` /
  // `*.dawn.test.ts` co-located here would fail with `webgpu-unavailable`
  // / `fetch failed`. The dedicated `browser` / `dawn` projects in the
  // root vitest.config.ts still pick those files up via their global
  // include globs (`**/*.browser.test.ts` / `**/*.dawn.test.ts`), so
  // excluding them only here removes the duplicate-execution-in-wrong-env
  // path while keeping the cross-environment coverage intact.
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
