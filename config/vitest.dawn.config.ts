import { defineConfig } from 'vitest/config';
import { dawnProject } from './vitest-dawn-project';
import { sharedVitestConfig } from './vitest-shared';

// Load the sole Dawn policy without importing unrelated browser command owners.
export default defineConfig({
  ...sharedVitestConfig,
  test: { ...sharedVitestConfig.test, projects: [dawnProject] },
});
