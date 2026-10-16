import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-shader',
    passWithNoTests: true,
    // The transmission contract files share one expensive manifest producer.
    // Keep one module graph for this package so its process-local manifest
    // cache is reused instead of compiling the same shader fleet twice.
    isolate: false,
    // Native GPU regressions run in the root Dawn project with WebGPU setup.
    exclude: [...configDefaults.exclude, '**/*.dawn.test.ts', '**/*.browser.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});
