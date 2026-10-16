import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-audio-webaudio',
    // Exclude `*.browser.test.ts` — those are owned by the root `browser`
    // vitest project. Without this, the node project picks them up and fails
    // (no AudioContext in node env). Mirrors app/runtime config policy.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});