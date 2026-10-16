import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/browser.ts', 'src/node.ts'],
  external: ['@forgeax/engine-net', '@forgeax/engine-types', 'ws'],
});
