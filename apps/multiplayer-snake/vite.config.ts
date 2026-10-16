import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never, vitePluginRhiDebug()],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: { target: 'esnext' },
});
