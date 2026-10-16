import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/standards.ts'],
  // Preserve the portable encoding implementation: its browser shortcut requires
  // the native globals this bootstrap must supply on WeChat devices.
  noExternal: [/^@exodus\/bytes(?:\/|$)/],
});
