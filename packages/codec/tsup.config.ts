import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/encode/index.ts', 'src/basis-browser.ts'],
  external: ['@forgeax/engine-codec/basis-factory'],
});
