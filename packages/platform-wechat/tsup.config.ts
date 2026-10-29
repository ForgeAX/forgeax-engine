import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig([
  { ...baseTsupConfig, entry: ['src/index.ts'] },
  {
    ...baseTsupConfig,
    entry: ['src/standards.ts'],
    // Standards must load before shared Engine chunks can evaluate native globals.
    // Bundle their complete portable closure, including the encoding fallback.
    noExternal: [/.*/],
  },
]);
