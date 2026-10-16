import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/inspector-client.ts'],
  // Keep ws as an external runtime import in the inspector-client sub-export
  // so Node consumers resolve it at import time; main entry no longer traces
  // into inspector-client.ts after T-01 deleted the export * re-export.
  external: ['ws'],
});
