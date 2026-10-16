import { defineProject } from 'vitest/config';

// Per-package node project for @forgeax/preview. DOM-only preview contracts
// use the file-level jsdom environment and remain in this unit project;
// preview.browser.test.ts is owned by the root `browser` Vitest project (K-3
// split). Exclude `*.browser.test.ts` so the per-package project's default
// include glob does NOT pick up the real WebGPU test in node env, which would
// cascade-fail under `vitest run --project='@forgeax/*'`. Mirrors
// packages/app/vitest.config.ts policy.
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/preview',
    // jsdom runs in Node. Keep the App's real Node dependency closure native
    // instead of client-transforming its filesystem import adapters.
    server: { deps: { external: [/\/packages\/app\/dist\//] } },
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
  },
});
