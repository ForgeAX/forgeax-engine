import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/native-host.ts'],
  // wasm-pack output `pkg/wgpu_wasm.js` is runtime-only; tsup must not bundle
  // it at build time (it is resolved relative to dist/index.mjs by Node /
  // Vite at import time). The wasm asset is loaded inside ensureReady() via
  // `new URL('../pkg/wgpu_wasm_bg.wasm', import.meta.url)` so no static asset
  // import sits at module top level (avoids Node interpreting `?url` suffix
  // as a wasm module import).
  external: ['../pkg/wgpu_wasm.js'],
});
