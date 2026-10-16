import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-multi-world vite config - mirror of the hello-cube / hello-triangle
// shape (charter proposition 5 consistent abstraction). The forgeaxShader
// plugin auto-emits dist/shaders/manifest.json with the engine-shipped
// pbr/unlit WGSL entries; the runtime consumes it via
// Renderer.ready -> shader.loadManifest. The demo owns no .wgsl source of its
// own (world B's lit box uses forgeax::default-standard-pbr via
// Materials.standard()).
export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
