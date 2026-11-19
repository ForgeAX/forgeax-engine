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
    // Browser and Dawn coverage belongs to the root device projects, which
    // install their actual DOM/backend environment. Keep package-local Node
    // discovery from collecting those files without that environment.
    exclude: [
      ...configDefaults.exclude,
      '**/*.browser.test.ts',
      '**/*.browser-no-webgpu.test.ts',
      '**/*.dawn.test.ts',
      '**/*.perf.test.ts',
    ],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});
