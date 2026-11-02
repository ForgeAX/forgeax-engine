import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildHousing } from './housing.ts';

/** Case C-012 as an ordinary procedural asset: `mesh/housing`, the thin-walled lower housing. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0012'),
  parameters: [
    { name: 'wall', type: 'f32', default: 0.002, minimum: 0.0012, maximum: 0.004 },
    { name: 'vents', type: 'u32', default: 5, minimum: 2, maximum: 8 },
  ],
  build: ({ values }) =>
    buildHousing({ wall: values.wall as number, vents: values.vents as number }).finish({
      key: 'housing',
      normals: { mode: 'weighted' },
    }),
});
