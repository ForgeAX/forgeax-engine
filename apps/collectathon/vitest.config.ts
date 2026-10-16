import { defineProject } from 'vitest/config';

// Per-package node project for @forgeax/collectathon. Owns the gameplay
// pure-logic unit tests under src/__tests__/ (player-move / core-collect /
// guardian-hit / win-lose-arbiter). Auto-discovered by the root vitest config
// via the `apps/*` glob (K-3 unit layer). Excludes *.browser.test.ts so the
// node env does not try to load the browser-only e2e probe.
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/collectathon',
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
  },
});
