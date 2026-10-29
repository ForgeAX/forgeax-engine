import { panelsChunk, panelsEntry, revisionPlugin } from '../../scripts/build-inputs.mjs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const viewHostOrigin = process.env.FORGEAX_VIEW_DEV_HOST_ORIGIN;

// View pins its exact Engine, whose package already carries its generated
// binaries. The build keeps their hashed URLs under assets/engine/ (served from
// the installed Engine by view-workspace-core/viewer-static) instead of
// shipping second copies.
const enginePackageAsset = (names: readonly string[] | undefined) =>
  names
    ?.map((name) => /(?:^|\/)packages\/([a-z0-9-]+)\/pkg\/[^/]+$/.exec(name)?.[1])
    .find((directory) => directory !== undefined);
const engineOwnedAssets: Plugin = {
  name: 'forgeax-view:engine-owned-assets',
  apply: 'build',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === 'asset' && enginePackageAsset(output.originalFileNames) !== undefined) {
        delete bundle[output.fileName];
      }
    }
  },
};

export default defineConfig({
  plugins: [revisionPlugin, react(), engineOwnedAssets],
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
        assetFileNames: (asset) => {
          const directory = enginePackageAsset(asset.originalFileNames);
          return directory === undefined
            ? 'assets/[name]-[hash][extname]'
            : `assets/engine/${directory}/[hash]/[name][extname]`;
        },
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
