import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildLamp } from './lamp.ts';

/**
 * Case C-002 as an ordinary procedural asset, `mesh/lamp`. Function reuse (design
 * 10.1): the build is a static import of the `lamp.ts` recipe module, so it caches
 * with this Pack and travels with its source.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0002'),
  parameters: [
    { name: 'height', type: 'f32', default: 0.22, minimum: 0.12, maximum: 0.4 },
    { name: 'reach', type: 'f32', default: 40, minimum: 15, maximum: 60 },
    { name: 'shadeRadius', type: 'f32', default: 0.075, minimum: 0.05, maximum: 0.11 },
  ],
  build: ({ values }) =>
    buildLamp({
      height: values.height as number,
      reach: values.reach as number,
      shadeRadius: values.shadeRadius as number,
    }).finish({ key: 'lamp', normals: { mode: 'weighted' } }),
});
