import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../../../config/vitest-browser-project';

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    projects: [createBrowserProject(), { test: { name: 'dawn', environment: 'node', include: ['src/**/*.dawn.test.ts'] } }],
  },
});
