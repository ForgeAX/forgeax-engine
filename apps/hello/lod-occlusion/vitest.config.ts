import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/hello-lod-occlusion',
    environment: 'node',
    include: [
      'src/__tests__/*.unit.test.ts',
      'src/__tests__/lod-occlusion-performance.integration.test.ts',
    ],
  },
});
