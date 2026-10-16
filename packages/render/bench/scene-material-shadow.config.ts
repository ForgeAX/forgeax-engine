import { defineConfig } from 'tsup';

// One render source identity is required: mixing source Renderer with built
// Camera components makes the diagnostic query a different component token.
export default defineConfig({
  entry: ['packages/render/bench/scene-material-shadow.mjs'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'artifacts/scene-material-scaling/shadow-bin',
  splitting: true,
  external: ['webgpu'],
  noExternal: [/^@forgeax\/engine-render(?:\/|$)/],
  esbuildOptions(options) {
    options.alias = {
      '@forgeax/engine-render/internal/construct-renderer': './packages/render/src/construct-renderer.ts',
      '@forgeax/engine-render/internal': './packages/render/src/internal.ts',
      '@forgeax/engine-render': './packages/render/src/index.ts',
    };
  },
});
