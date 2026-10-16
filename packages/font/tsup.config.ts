import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/cli-font.ts', 'src/font-importer.ts', 'src/node-msdf-worker.mjs'],
  external: [
    '@forgeax/engine-types',
    '@forgeax/engine-pack',
    '@forgeax/engine-remote',
    '@zappar/msdf-generator',
  ],
});
