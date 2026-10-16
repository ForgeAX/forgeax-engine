import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const devPort = Number(process.env.FORGEAX_REMOTE_DEMO_PORT ?? '5173');

// remote-demo vite config — mirror of hello-cube vite.config.ts shape.
// The forgeaxShader plugin is injected so the production app
// exercises the same shader-pipeline path as hello-triangle / hello-cube.
//
// createApp auto-wires app.remote in dev mode — no manual Registry /
// startConsoleServer assembly needed. The bundler adapter via
// forgeaxBundlerAdapter() is the SSOT for host-injected build-tool
// knowledge (feat-20260608-create-app-param-surface-trim).
export default defineConfig({
  plugins: [forgeaxShader() as never, vitePluginRhiDebug()],
  server: {
    port: devPort,
    strictPort: true,
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
