import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    'externalization/index': 'src/externalization/index.ts',
    index: 'src/index.ts',
    internal: 'src/internal.ts',
    'projection/index': 'src/projection/index.ts',
    shared: 'src/shared.ts',
    'world-read': 'src/world-read.ts',
  },
  external: ['@forgeax/engine-math', '@forgeax/engine-types'],
});
