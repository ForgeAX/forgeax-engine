import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const root = fileURLToPath(new URL('.', import.meta.url));
const monorepoRoot = resolve(root, '..', '..', '..');
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    headers: isolationHeaders,
    fs: { allow: [monorepoRoot] },
  },
  preview: { headers: isolationHeaders },
  build: {
    target: 'esnext',
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        index: resolve(root, 'index.html'),
        m27: resolve(root, 'm27.html'),
        m28: resolve(root, 'm28.html'),
        m29: resolve(root, 'm29.html'),
        m30: resolve(root, 'm30.html'),
        m31: resolve(root, 'm31.html'),
        m32: resolve(root, 'm32.html'),
        m33: resolve(root, 'm33.html'),
        m34: resolve(root, 'm34.html'),
        m35: resolve(root, 'm35.html'),
        m36: resolve(root, 'm36.html'),
        m37: resolve(root, 'm37.html'),
        m38: resolve(root, 'm38.html'),
        'm26-bootstrap': resolve(root, 'src/m26-bootstrap.ts'),
        'm27-bootstrap': resolve(root, 'src/m27-bootstrap.ts'),
        'm28-bootstrap': resolve(root, 'src/m28-bootstrap.ts'),
        'm29-bootstrap': resolve(root, 'src/m29-bootstrap.ts'),
        'm30-bootstrap': resolve(root, 'src/m30-bootstrap.ts'),
        'm31-bootstrap': resolve(root, 'src/m31-bootstrap.ts'),
        'm32-bootstrap': resolve(root, 'src/m32-bootstrap.ts'),
        'm33-bootstrap': resolve(root, 'src/m33-bootstrap.ts'),
        'm34-bootstrap': resolve(root, 'src/m34-bootstrap.ts'),
        'm35-bootstrap': resolve(root, 'src/m35-bootstrap.ts'),
        'm36-bootstrap': resolve(root, 'src/m36-bootstrap.ts'),
        'm37-bootstrap': resolve(root, 'src/m37-bootstrap.ts'),
        'm38-bootstrap': resolve(root, 'src/m38-bootstrap.ts'),
      },
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
});
