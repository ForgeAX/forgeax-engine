import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-math',
    // Vitest 4.x: when using `projects:`, typecheck must be opted into per
    // project -- root `typecheck.enabled` is ignored at project scope. Without
    // this, `*.test-d.ts` files are silently skipped.
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    // T-035: property test single run with numRuns=100 x ~50ms = 5s, close to
    // vitest default 5000ms timeout; mat4 x mat4 x mat4 chain (NUM_RUNS_TRIPLE)
    // occasionally jitters to 8-12s. Bump to 15s buffer, aligned with R-P4
    // (PBT single-case duration cap).
    testTimeout: 15000,
    // One fork worker: each file otherwise pays ~15s of vitest+vite startup.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      // T-035: *.property.test.ts is excluded from coverage denom
      // - *.property.test.ts is test code (vitest auto-excludes it); listed
      //   explicitly here as belt-and-suspenders so the _arbs.ts helper is
      //   never miscounted as source (already covered by the __tests__/ glob).
      exclude: [
        '**/*.bench.ts',
        '**/*.property.test.ts',
        'src/__tests__/**',
        // plan-strategy section 4.1 waiver: _internal/_* helpers are
        // indirectly covered, no >= 80% direct-coverage requirement (public
        // API surface tests already exercise the hot use cases; dead helpers
        // do not count).
        'src/_internal/**',
        'dist/**',
        'scripts/**',
        '**/*.config.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
