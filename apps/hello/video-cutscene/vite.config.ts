import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// The cutscene.webm is host-side DOM (index.html <video src="/cutscene.webm">),
// NOT an engine pack asset -- no GUID sidecar, no pluginPack. The engine repo
// tracks zero binaries, so the webm lives in the forgeax-engine-assets submodule
// (demo-assets/hello-video-cutscene/, mirroring hello-sprite / hello-audio).
// Pointing vite's static `publicDir` at that submodule dir serves the file at
// `/cutscene.webm` unchanged. Cloning without --recurse-submodules leaves the
// dir absent -> the <video> 404s and the cutscene never plays (charter P3
// explicit failure).
const demoAssets = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets', 'hello-video-cutscene');

export default defineConfig({
  publicDir: demoAssets,
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
