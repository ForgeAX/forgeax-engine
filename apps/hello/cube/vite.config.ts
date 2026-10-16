import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-cube vite config - mirror of hello-triangle vite.config.ts shape
// (D-S10 binding exemplar consistency). The forgeaxShader plugin is injected
// so the production app exercises the same shader-pipeline path as
// hello-triangle (charter proposition 5 consistent abstraction).
//
// build.rollupOptions.input is single-entry (main: index.html); the engine
// internally consumes the manifest produced by the plugin via
// Renderer.ready -> shader.loadManifest. hello-cube does not own a separate
// .wgsl source - the forgeaxShader plugin auto-emits a manifest.json with
// pbr/unlit entries via @forgeax/engine-vite-plugin-shader
// (feat-20260518-pbr-direct-lighting-mvp M5 / w22.8: the engine's WGSL
// SSOT lives in packages/shader/src/{pbr,unlit}.wgsl; the legacy inline
// PBR fallback was deleted in w22.9).
// vitePluginRhiDebug (feat-20260617 M4 / w25): mounts the dev-only
// POST /__forgeax-debug/tape endpoint + injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG.
// With FORGEAX_ENGINE_RHI_DEBUG=1 in the env, the createApp guard mounts
// window.__forgeax.captureFrame(n) -> capture-browser round-trip. hello-cube's
// main.ts bootstraps via createApp so the guard fires (browser e2e w22).
export default defineConfig({
  plugins: [forgeaxShader() as never, vitePluginRhiDebug()],
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
