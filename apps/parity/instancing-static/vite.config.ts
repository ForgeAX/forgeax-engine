import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// parity-instancing-static vite config — M4 T-M4-3 fixture for AC-09.
//
// Preview port 4175 + strictPort=true: distinct from apps/parity/forgeax (4174)
// + apps/parity/threejs (4173) so scripts/metrics/run-fps.mjs can boot this
// fixture independently without port collisions on the same CI runner.
//
// The forgeaxShader plugin is injected so the build emits the manifest.json
// with pbr/unlit entries via @forgeax/engine-vite-plugin-shader; the
// fixture itself ships no .wgsl source (post-w22.8/w22.9 the engine no
// longer ships an inline fallback shader, the runtime path consumes the
// manifest entries via Renderer.ready -> shader.loadManifest).
export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  preview: {
    port: 4175,
    strictPort: true,
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
