import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    material: 'src/material.ts',
    mesh: 'src/mesh.ts',
    vfx: 'src/vfx.ts',
    texture: 'src/texture.ts',
  },
  external: ['@forgeax/engine-tool-runtime'],
});
