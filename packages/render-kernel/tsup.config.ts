import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    'hot-path': 'src/hot-path.ts',
    'desktop/index': 'src/desktop/index.ts',
  },
  external: [
    '@forgeax/engine-types',
    '@forgeax/engine-rhi',
    '@webgpu/types',
    'node:fs',
    'node:fs/promises',
    'node:module',
    'node:process',
    'node:url',
    'node:path',
  ],
  async onSuccess() {
    const srcWasm = resolve('wasm/forgeax_render_kernel_wasm_bg.wasm');
    const dstWasm = resolve('dist/forgeax_render_kernel_wasm_bg.wasm');
    if (existsSync(srcWasm)) {
      copyFileSync(srcWasm, dstWasm);
    }
  },
});
