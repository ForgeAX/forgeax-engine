import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-app vite config - mirror of hello-cube vite.config.ts shape
// (feat-20260518-app-shell-game-loop M6 / D-12). The forgeaxShader plugin
// is injected so the production app exercises the same shader-pipeline
// path as hello-cube; createApp(canvas, opts?) inside main.ts forwards
// any renderer bundler options to the host factory untouched.
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
