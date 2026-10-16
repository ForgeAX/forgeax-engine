import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/browser.ts', 'src/mesh-bin.ts', 'src/mesh-lod-generator.ts', 'src/navigation-bake.ts'],
  external: ['@forgeax/engine-pack', '@forgeax/engine-types'],
});
