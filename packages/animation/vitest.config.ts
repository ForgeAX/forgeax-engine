import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

// Diagnostics are an authored development contract; isolate ambient shell mode.
process.env.NODE_ENV = 'test';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/engine-animation',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
});
