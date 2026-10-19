import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';

export default defineConfig({
  plugins: [forgeaxShader()],
  server: { host: '0.0.0.0', headers: {
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  } },
  build: { target: 'esnext' },
});
