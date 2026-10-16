import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const directory = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: directory,
  server: {
    hmr: false,
    port: 5295,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] },
  },
});
