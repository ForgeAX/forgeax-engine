import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-room');

// hello-room vite config - mirror of hello-cube vite.config.ts shape
// (feat-20260511-asset-system-v1 / D-P7 convergence app consistency). The
// forgeaxShader plugin injects the build-time shader pipeline so hello-room
// exercises the same WGSL path as hello-cube / hello-triangle (charter
// proposition 5 consistent abstraction).
//
// hello-room does NOT own a separate .wgsl source - the forgeaxShader
// plugin auto-emits a manifest.json with pbr/unlit entries via
// @forgeax/engine-vite-plugin-shader (feat-20260518-pbr-direct-lighting-mvp
// M5 / w22.8: replaces the legacy inline fallback shader path; the engine
// `ShaderRegistry` consumes the manifest entries via Renderer.ready ->
// shader.loadManifest). Single-entry build (index.html) keeps parity with
// hello-cube; both MeshRenderer archetypes dispatched by RenderSystem via
// the MaterialAsset.shadingModel discriminant (plan-strategy D-P4) resolve
// to the same manifest hashes.
export default defineConfig({
  plugins: [forgeaxShader() as never, pluginPack({ runtimeBinding, roots: [resolve(here, 'assets')], refresh: reloadAssetHost() })],
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
