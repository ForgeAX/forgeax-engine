import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';
import { FOLIAGE_MATERIAL_PACKAGES } from './src/material-contract.ts';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader({
      materialPackages: FOLIAGE_MATERIAL_PACKAGES.map((file) => resolve(here, 'src', file)),
    }) as never,
    vitePluginRhiDebug()],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
