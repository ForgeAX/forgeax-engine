import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineProject } from 'vitest/config';

// Node contracts import the real virtual bundler adapter but submit no frames.
// Browser/RHI-debug entrypoints retain Vite's complete engine shader preparation.
export default defineProject({
  plugins: [forgeaxShader({ engineEntries: false }) as never],
  test: {
    name: '@forgeax/multiplayer-snake',
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
