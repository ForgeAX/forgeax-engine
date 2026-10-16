import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-cinder-fall');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [resolve(here, 'assets')],
      cookers: [
        createMaterialPackCooker([resolve(here, 'assets')]),
        createParticleCodeNativeCookerFromRoots(
          [resolve(here, 'assets')],
          { 'c1de0000-0000-7000-8000-000000000002': [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
        ),
      ],
      refresh: reloadAssetHost(),
      runtimeBinding,
    }),
  ],
  server: { port: 5187, fs: { allow: [monorepoRoot] } },
  build: {
    target: 'esnext',
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
