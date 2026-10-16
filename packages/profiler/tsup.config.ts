import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  noExternal: [/^ajv(?:\/|$)/],
  entry: ['src/index.ts', 'src/cli.ts', 'src/browser-user-timing.ts'],
});
