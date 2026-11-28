import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/modeling-kernel-three',
    passWithNoTests: true,
  },
});
