import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/cli-gltf.ts', 'src/node-file-entry.ts', 'src/importer-entry.ts', 'src/node-importer-entry.ts'],
  external: ['@forgeax/engine-math', '@forgeax/engine-pack', '@forgeax/engine-types'],
});
