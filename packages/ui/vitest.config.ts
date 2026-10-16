import { defineProject } from 'vitest/config';
export default defineProject({
  test: {
    environment: 'jsdom',
    name: '@forgeax/engine-ui',
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['**/*.browser.test.ts'],
  },
});
