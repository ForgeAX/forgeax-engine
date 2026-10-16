import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
// apps/shadertoy/happy-blob -> three levels up to the monorepo root.
const monorepoRoot = resolve(here, '..', '..', '..');

// The forgeaxShader plugin compiles happy-blob.wgsl at transform time; the
// sidecar happy-blob.pack.json routes it through the material-shader
// compose path and lands the composed WGSL + paramSchema in the shader
// manifest for ShaderRegistry.installMaterialArtifact at engine boot.
export default defineConfig({
  plugins: [forgeaxShader({ materialPackages: [resolve(here, 'src/happy-blob.pack.json')] }) as never],
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
