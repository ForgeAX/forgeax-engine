import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-vfx-compiler',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test-d.ts'],
    // Real Dawn coverage is owned by the root `dawn` project, which installs
    // navigator.gpu before collecting `*.dawn.test.ts`. The package-local node
    // project must not collect those files without that environment.
    exclude: ['**/dist/**', '**/node_modules/**', '**/*.dawn.test.ts'],
  },
});
