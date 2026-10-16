import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { withRhiDebug } from '../../shared/src/rhi-debug-vite-preset';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-boss-lightning');
const config = withRhiDebug({
  here,
  rootDepth: 3,
  port: 5274,
  materialPackages: [
    resolve(here, 'assets/arc-nova-sigil.shader.pack.json'),
    resolve(here, 'assets/arc-nova-violet-sigil.shader.pack.json'),
  ],
  extraPlugins: [
    pluginPack({
      roots: [resolve(here, 'assets')],
      cookers: [
        createMaterialPackCooker([resolve(here, 'assets')]),
        createParticleCodeNativeCookerFromRoots([resolve(here, 'assets')]),
      ],
      refresh: reloadAssetHost(),
      runtimeBinding,
    }),
  ],
});
config.build = {
  ...config.build,
  rollupOptions: {
    ...config.build?.rollupOptions,
    input: {
      main: resolve(here, 'index.html'),
      fields: resolve(here, 'fields.html'),
      sdf: resolve(here, 'sdf.html'),
    },
  },
};
export default config;
