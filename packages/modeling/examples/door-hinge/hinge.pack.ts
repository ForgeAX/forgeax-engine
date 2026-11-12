import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildDoorHinge } from './hinge.ts';

/** Case C-103 as an ordinary procedural asset: `mesh/door-hinge` at a door opening angle. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0103'),
  parameters: [{ name: 'openAngle', type: 'f32', default: 110, minimum: 100, maximum: 180 }],
  build: ({ values }) =>
    buildDoorHinge({ openAngle: values.openAngle as number }).finish({
      key: 'door-hinge',
      normals: { mode: 'weighted' },
    }),
});
