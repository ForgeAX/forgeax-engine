import { relative, resolve } from 'node:path';
import { createMaterialPackCooker } from '@forgeax/engine/shader-compiler';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine/vfx-compiler';
import { pluginPack } from '@forgeax/engine/vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';

const root = import.meta.dirname;
const assets = resolve(root, 'assets');
const fieldSources = new Set([
  'field-effects.pack.json',
  'fields-affine-spatial-on.vfx.wgsl',
  'fields-boundary-off.vfx.wgsl',
  'fields-boundary-on.vfx.wgsl',
  'fields-off.vfx.wgsl',
  'fields-on.vfx.wgsl',
  'fields.pack.ts',
]);
export default {
  root,
  plugins: [
    forgeaxShader({ publishAuthoredMaterialShaders: false }),
    pluginPack({
      roots: [assets],
      ignorePath: path => !fieldSources.has(relative(assets, path)),
      cookers: [createMaterialPackCooker([assets]), createParticleCodeNativeCookerFromRoots([assets])],
    }),
  ],
  build: {
    outDir: resolve(root, '.forgeax/roi21-fields-dist'),
    rollupOptions: { input: resolve(root, 'roi21-fields.html') },
  },
};
