import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/engine-navigation',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
});
