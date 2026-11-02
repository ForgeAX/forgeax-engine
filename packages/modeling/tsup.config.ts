import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    'tools/index': 'src/tools/index.ts',
    'tools/capture-worker': 'src/tools/capture-worker.ts',
    'tools/capture-host': 'src/tools/capture-host.ts',
    'tools/bake-worker': 'src/tools/bake-worker.ts',
    'tools/mesh-job-worker': 'src/tools/mesh-job-worker.ts',
  },
  // The capture Worker must share the modeling module instance the captured Pack imports.
  external: ['@forgeax/engine-modeling'],
  // The published package ships src/, which the maps reference; embedding it again as
  // sourcesContent doubled the package and pushed the bundled Engine past its budget.
  esbuildOptions(options) {
    options.sourcesContent = false;
  },
});
