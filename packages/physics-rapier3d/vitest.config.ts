import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    name: '@forgeax/engine-physics-rapier3d',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
