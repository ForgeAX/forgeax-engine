import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/native-host.ts'],
  // wasm-pack output `pkg/wgpu_wasm.js` is runtime-only; tsup must not bundle
  // it at build time (it is resolved relative to dist/index.mjs by Node or a
  // browser host at import time). The WASM asset is loaded inside ensureReady()
  // through a module-relative URL, so no static asset import sits at module
  // top level.
  external: ['../pkg/wgpu_wasm.js'],
});
