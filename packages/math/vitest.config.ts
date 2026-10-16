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
    // T-035: bench files live under packages/math/bench/, physically isolated
    // from src/__tests__/ (D-P11 / wiki/vitest-bench section 5). The explicit
    // include lets `vitest bench` discover them via the monorepo root config;
    // exclude drops residual dist artefacts.
    benchmark: {
      include: ['bench/*.bench.ts'],
      exclude: ['**/dist/**', '**/node_modules/**'],
      reporters: ['default'],
    },
    // Bench wall-time tuning (CI math bench runs in metrics-validate and only
    // consumes median ns/op via scripts/metrics/run-all.mjs#collectBenchMedians).
    // Each *.bench.ts file otherwise spawns its own fork worker (~15s of
    // vitest+vite startup per file observed locally), so 4 bench files hit ~60s
    // before measurement even starts. singleFork collapses them onto one
    // worker; combined with FORGEAX_BENCH=fast tinybench knobs (bench/_opts.ts)
    // the full bench step lands around ~18-20s. Local `pnpm bench` keeps the
    // statistical defaults via the env-var gate.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      // T-035: bench/ and *.property.test.ts are excluded from coverage denom
      // - bench/ is performance-measurement code; coverage is meaningless here
      // - *.property.test.ts is test code (vitest auto-excludes it); listed
      //   explicitly here as belt-and-suspenders so the _arbs.ts helper is
      //   never miscounted as source (already covered by the __tests__/ glob).
      exclude: [
        'bench/**',
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
