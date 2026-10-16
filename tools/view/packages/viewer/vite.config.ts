import { panelsChunk, panelsEntry, revisionPlugin } from '../../scripts/build-inputs.mjs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { assetReferenceVitePlugin } from '../../scripts/asset-reference-program.mjs';

const viewHostOrigin = process.env.FORGEAX_VIEW_DEV_HOST_ORIGIN;

export default defineConfig({
  plugins: [revisionPlugin, assetReferenceVitePlugin, react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  root: resolve(import.meta.dirname),
  build: {
    outDir: resolve(import.meta.dirname, '../../dist/viewer'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      preserveEntrySignatures: 'exports-only',
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        panels: panelsEntry,
      },
      output: {
        manualChunks: panelsChunk,
        entryFileNames: (chunk) => (chunk.name === 'panels' ? 'panels.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: viewHostOrigin ? {
      '/__forgeax/view/bootstrap': { target: viewHostOrigin, changeOrigin: true },
      '/__forgeax/view/health': { target: viewHostOrigin, changeOrigin: true },
    } : undefined,
  },
});
