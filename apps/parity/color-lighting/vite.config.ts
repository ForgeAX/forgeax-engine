import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const productHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: monorepoRoot, encoding: 'utf8' }).trim();

export default defineConfig({
  plugins: [forgeaxShader() as never],
  define: { __FORGEAX_PRODUCT_HEAD__: JSON.stringify(productHead) },
  server: { fs: { allow: [monorepoRoot] } },
  preview: { port: 4176, strictPort: true },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        lightingDemo: resolve(here, 'lighting-demo.html'),
      },
    },
  },
});
