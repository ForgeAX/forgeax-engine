import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'jsdom',
    // jsdom only exposes localStorage when an origin is set; the viewer tests
    // use localStorage for deterministic browser-like state.
    environmentOptions: { jsdom: { url: 'http://localhost' } },
    // Pin globalThis.localStorage to jsdom's (Node 22+ ships a conflicting
    // experimental global); see setup.ts.
    setupFiles: ['./src/__tests__/setup.ts'],
    name: '@forgeax/engine-rhi-debug-viewer',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    // Exclude `*.dawn.test.ts` -- owned by the root `dawn` vitest project
    // (vitest.config.ts projects, K-3 split). Without this the jsdom unit
    // project's include glob picks up the dawn mechanism test in jsdom env
    // (no navigator.gpu, no dawn injection setupFiles) and it cannot run.
    // Mirror of packages/rhi-debug/vitest.config.ts.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.dawn.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
