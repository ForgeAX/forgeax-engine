import { defineConfig } from 'tsup';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  esbuildPlugins: [{ name: 'wgsl-source', setup(build) {
    build.onLoad({ filter: /\.wgsl\?raw$/ }, async ({ path }) => ({ contents: await readFile(path.slice(0, -4), 'utf8'), loader: 'text' }));
    build.onResolve({ filter: /\.wgsl\?raw$/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path) }));
  } }],
  external: ['@forgeax/engine-codec', '@forgeax/engine-rhi', '@forgeax/engine-types', '@webgpu/types'],
});
