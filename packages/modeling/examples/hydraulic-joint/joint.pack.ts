import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildJoint } from './joint.ts';

/** Case C-102 as an ordinary procedural asset: `mesh/hydraulic-joint` at a cylinder extension. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0102'),
  parameters: [{ name: 'extension', type: 'f32', default: 0.5, minimum: 0, maximum: 1 }],
  build: ({ values }) =>
    buildJoint({ extension: values.extension as number }).finish({
      key: 'hydraulic-joint',
      normals: { mode: 'weighted' },
    }),
});
