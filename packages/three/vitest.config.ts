import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const require = createRequire(import.meta.url);
export default defineProject({
  resolve: {
    alias: [
      ...['materials', 'physical'].map((name) => ({
        // CI restores packaged publications, not ignored producer intermediates.
        find: `./generated/${name}.mjs`,
        replacement: fileURLToPath(new URL(`./dist/${name}.mjs`, import.meta.url)),
      })),
      {
        find: /^three$/,
        replacement: require.resolve('three/src/Three.Core.js'),
      },
    ],
  },
  test: {
    name: '@forgeax/engine-three',
    environment: 'node',
    include: ['src/__tests__/*.test.ts'],
    exclude: ['src/__tests__/*.browser.test.ts', 'src/__tests__/*.dawn.test.ts'],
    coverage: {
      exclude: ['**/node_modules/**', 'dist/**', '**/*.config.ts', 'src/__tests__/**'],
      thresholds: { lines: 80, branches: 80, functions: 80 },
    },
  },
});
