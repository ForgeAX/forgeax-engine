import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  platform: 'node',
  entry: { index: 'src/index.ts' },
  external: [
    '@deepseek-ai/dsh-sdk-client',
    '@forgeax/engine-intelligence',
    '@forgeax/engine-types',
  ],
});
