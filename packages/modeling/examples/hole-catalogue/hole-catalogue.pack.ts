import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildHoleCatalogue } from './hole-catalogue.ts';

/** Case SC-L3 as an ordinary procedural asset: `mesh/hole-catalogue` with a blind-row depth. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000005c003'),
  parameters: [{ name: 'blindDepth', type: 'f32', default: 0.012, minimum: 0.008, maximum: 0.016 }],
  build: ({ values }) =>
    buildHoleCatalogue({ blindDepth: values.blindDepth as number }).finish({
      key: 'hole-catalogue',
      normals: { mode: 'weighted' },
    }),
});
