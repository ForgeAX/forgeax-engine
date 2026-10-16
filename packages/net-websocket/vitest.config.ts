import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-net-websocket',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['__tests__/**/*.browser.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
