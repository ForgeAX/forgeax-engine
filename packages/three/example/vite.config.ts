import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';

export default defineConfig({
  plugins: [forgeaxShader()],
  server: { host: '0.0.0.0', headers: {
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  } },
  build: { target: 'esnext', rollupOptions: { input: {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    compare: fileURLToPath(new URL('./compare.html', import.meta.url)),
    textures: fileURLToPath(new URL('./textures.html', import.meta.url)),
  } } },
});
