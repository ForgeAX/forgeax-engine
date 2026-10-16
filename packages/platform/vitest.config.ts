import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: '@forgeax/engine-platform', environment: 'node', exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'] } });
