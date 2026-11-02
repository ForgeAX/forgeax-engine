import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildForearm } from './forearm.ts';

/**
 * Case C-016 as an ordinary procedural asset: the ARAP-fitted, faired forearm guard
 * (`mesh/forearm`). The bend-fitted comparison session is not exported.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0016'),
  parameters: [
    { name: 'elbow', type: 'f32', default: 30, minimum: 15, maximum: 30 },
    { name: 'wrist', type: 'f32', default: 35, minimum: 20, maximum: 45 },
    { name: 'wall', type: 'f32', default: 0.016, minimum: 0.012, maximum: 0.02 },
  ],
  build: ({ values }) =>
    buildForearm({
      elbow: values.elbow as number,
      wrist: values.wrist as number,
      wall: values.wall as number,
    }).finish({ key: 'forearm', normals: { mode: 'autoSmooth', angle: 35 } }),
});
