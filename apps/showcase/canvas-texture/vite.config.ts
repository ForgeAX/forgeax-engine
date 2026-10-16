import { fileURLToPath } from 'node:url';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [forgeaxShader() as never, vitePluginRhiDebug()],
  server: { fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } },
  build: { target: 'esnext' },
});
