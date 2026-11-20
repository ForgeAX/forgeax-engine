import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripWgslComments } from '@forgeax/engine-types';
import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  esbuildPlugins: [{
    name: 'wgsl-source',
    setup(build) {
      build.onLoad({ filter: /\.wgsl\?raw$/ }, async ({ path }) => {
        const source = await readFile(path.slice(0, -4), 'utf8');
        // Keep source lines for GPU diagnostics without shipping composer comments.
        return { contents: stripWgslComments(source), loader: 'text' };
      });
      build.onResolve({ filter: /\.wgsl\?raw$/ }, ({ path, resolveDir }) => ({
        path: resolve(resolveDir, path),
      }));
    },
  }],
  external: ['@forgeax/engine-codec', '@forgeax/engine-rhi', '@forgeax/engine-types', '@webgpu/types'],
});
