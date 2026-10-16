import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: { fs: { allow: [monorepoRoot] } },
  build: {
    target: 'esnext',
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
