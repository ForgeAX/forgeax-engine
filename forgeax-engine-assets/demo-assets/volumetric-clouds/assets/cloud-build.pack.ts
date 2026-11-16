import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

export default definePack({
  schemaVersion: '2.0.0',
  plugins: true,
  packageId: definePackageId('be4745e0-72cf-40b1-89a9-c0d34a661011'),
  build: () => ok({
    'plugin/build': {
      kind: 'plugin',
      module: { specifier: '@forgeax-assets/volumetric-clouds/build', export: 'build' },
    },
  }),
});
