import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // Bundle the portable CommonJS codec for native-ESM browser hosts. Keep
  // its package condition external until the consumer selects its realm.
  noExternal: ['pako'],
  entry: [
    'src/index.ts',
    'src/browser.ts',
    'src/protocol/gzip.ts',
    'src/protocol/gzip-node.ts',
  ],
  external: [
    '#tape-gzip',
    'node:zlib',
    '@forgeax/engine-rhi',
    '@forgeax/engine-types',
    '@webgpu/types',
    // Backend packages remain optional peer implementations and are not bundled.
    '@forgeax/engine-rhi-webgpu',
    '@forgeax/engine-rhi-wgpu',
  ],
});
