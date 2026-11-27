import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    key: 'src/key.ts',
    'entry-store': 'src/entry-store.ts',
    errors: 'src/errors.ts',
  },
  target: 'node22',
});
