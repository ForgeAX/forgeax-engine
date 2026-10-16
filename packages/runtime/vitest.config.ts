import { defineProject } from 'vitest/config';
import { createRenderSourceAliases } from '../../config/vitest-render-source-alias';

// Pin NODE_ENV so this run is hermetic. `import.meta.env.DEV` is constant-folded
// from NODE_ENV when vitest resolves the Vite config (DEV === NODE_ENV !==
// 'production'), which happens after this module evaluates -- so setting it here
// wins. Without it, a developer shell that exports NODE_ENV=production silently
// freezes DEV=false, dead-stripping the dev-only console.info/warn branches this
// suite asserts (mesh-ssbo capacity info, multi-light cap warn, animation
// throttle warn): 18 tests then fail locally while CI (no NODE_ENV) stays green,
// with errors (spy expected 1, got 0) that do not point at the cause.
process.env.NODE_ENV = 'test';

export default defineProject({
  resolve: {
    alias: createRenderSourceAliases(),
  },
  test: {
    environment: 'node',
    name: '@forgeax/engine-runtime',
    // Runtime unit files install incompatible WebGL/WASM module doubles. Keeping
    // them in one process preserves Vitest's per-file isolation while preventing
    // a real wgpu-wasm initialization from observing another file's mock canvas.
    fileParallelism: false,
    // Exclude `*.browser.test.ts` / `*.dawn.test.ts` — those are owned by the
    // root `browser` / `dawn` vitest projects (K-3 split stance, root vitest.config.ts
    // §projects). Without this, per-package project's default include glob picks
    // up the dedicated test files in node env (no document / no dawn-injection
    // setupFiles), causing cascade fail under `pnpm test:unit`.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.browser-no-webgpu.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
