import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { pluginPack } from '@forgeax/engine/vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';
import { executionWorkerEntries } from '@forgeax/engine/devkit/plugin-build';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { audioImporter } from '@forgeax/engine/audio-webaudio/audio-importer';

const directory = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: directory,
  define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': JSON.stringify(process.env.FORGEAX_AUDIO_RHI_CAPTURE === '1' ? '1' : '0') },
  plugins: [executionWorkerEntries(), forgeaxShader(), pluginPack({ roots: [directory, fileURLToPath(new URL('../../../../artifacts/roi22-acoustics/sources', import.meta.url))],
    importers: [audioImporter], runtimeBinding: createStandaloneRuntimeAssetBinding('roi22-acoustics') })],
  server: { hmr: false, port: 5296, strictPort: true,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  build: { outDir: 'dist', target: 'esnext', rollupOptions: {
    preserveEntrySignatures: 'strict',
    input: { index: resolve(directory, 'index.html'), 'acoustic-bootstrap': resolve(directory, 'bootstrap.ts'), 'acoustic-kernel': resolve(directory, 'kernel.ts') },
    output: { entryFileNames: 'assets/[name].js' },
  } },
});
