import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const root = fileURLToPath(new URL('.', import.meta.url));
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    target: 'esnext',
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        index: resolve(root, 'index.html'),
        'shared-bootstrap': resolve(root, 'src/shared-bootstrap.ts'),
        'shared-kernel': resolve(root, 'src/shared-kernel.ts'),
        'fault-kernel': resolve(root, 'src/fault-kernel.ts'),
      },
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
});
