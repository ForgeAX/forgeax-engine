import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildSuspension } from './suspension.ts';

/** Case C-104 as an ordinary procedural asset: `mesh/suspension`, the left front double-wishbone corner. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0104'),
  parameters: [
    { name: 'armRadius', type: 'f32', default: 0.012, minimum: 0.008, maximum: 0.016 },
    { name: 'springTurns', type: 'f32', default: 6, minimum: 3, maximum: 10 },
    { name: 'wire', type: 'f32', default: 0.0055, minimum: 0.003, maximum: 0.008 },
    { name: 'bend', type: 'f32', default: 0.035, minimum: 0.025, maximum: 0.06 },
  ],
  build: ({ values }) =>
    buildSuspension({
      armRadius: values.armRadius as number,
      springTurns: values.springTurns as number,
      wire: values.wire as number,
      bend: values.bend as number,
    }).finish({ key: 'suspension', normals: { mode: 'weighted' } }),
});
