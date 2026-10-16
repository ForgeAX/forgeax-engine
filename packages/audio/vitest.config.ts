import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-audio',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});