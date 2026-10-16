import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-render',
    passWithNoTests: true,
    // Real Dawn coverage belongs to the root `dawn` project, which installs
    // the native WebGPU binding in its setup file. Keep the package-local
    // Node project from collecting the file without that environment.
    exclude: [
      ...configDefaults.exclude,
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
      '**/*.perf.test.ts',
    ],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});
