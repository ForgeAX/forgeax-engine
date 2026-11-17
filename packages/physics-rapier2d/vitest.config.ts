import { defineProject } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  tsconfig: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
  test: {
    environment: 'node',
    name: '@forgeax/engine-physics-rapier2d',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
