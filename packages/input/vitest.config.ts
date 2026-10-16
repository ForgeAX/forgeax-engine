import { defineProject } from 'vitest/config';

// engine-input unit tests (vitest unit project). Typecheck enabled at the
// project scope so *.test-d.ts assertions on mouse.button(i: 0 | 1 | 2)
// literal narrowing are surfaced by the same `pnpm test:unit` invocation
// (TDD red-green path per plan-strategy section 5.1; aligns with
// packages/math/vitest.config.ts).
//
// Coverage thresholds at 70% per plan-strategy section 5.4 (browser-backend
// has DOM-side branches that node env cannot exercise).
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-input',
    // Browser-marked edge-latch and PointerLock journeys are owned by the
    // root Playwright project; keep them out of this node/forks project.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      // Lines floor 70% per plan-strategy section 5.4 -- "@forgeax/engine-input
      // >= 70% (browser backend partial paths need browser-mode)". Branches
      // and functions are intentionally not floored: browser-backend.ts has
      // DOM listener handlers (onMouseMove / onCanvasClick / requestPointerLock)
      // that cannot fire under the node-env unit project; the M2b browser
      // layer covers those paths (charter P5 -- physical role split between
      // unit + browser test layers; see plan-strategy section 5.1 / 5.4).
      thresholds: {
        lines: 70,
      },
    },
  },
});
