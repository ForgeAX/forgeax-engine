import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig([
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: {
      index: 'src/index.ts',
      'build-process': 'src/build/build-process.ts',
      'pack-program-host': 'src/build/pack-program-host.ts',
      'plugin-build': 'src/plugin-build.ts',
    },
  },
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: ['src/cli.ts'],
    // Preserve operation-owned imports in the published CLI. A single bundle
    // hoists their external Vite/browser imports back into every control call.
    splitting: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
