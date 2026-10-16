import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-physics-rapier2d',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
