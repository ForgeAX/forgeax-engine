import { fileURLToPath } from 'node:url';
import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Match main's test source configuration while anchoring it to this package.
  // The production exclusions must not send Oxc to the root solution on Windows.
  tsconfig: fileURLToPath(new URL('./tsconfig.test.json', import.meta.url)),
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
