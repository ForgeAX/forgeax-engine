import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildWheelRim } from './wheel-rim.ts';

/**
 * Case C-101 as an ordinary procedural asset, `mesh/wheel-rim`: the C-100 alloy rim
 * from its nominal size (bead seat diameter), width, spoke count and offset (ET).
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0101'),
  parameters: [
    { name: 'diameter', type: 'f32', default: 0.508, minimum: 0.4572, maximum: 0.5588 },
    { name: 'width', type: 'f32', default: 0.2413, minimum: 0.2032, maximum: 0.3302 },
    { name: 'spokes', type: 'u32', default: 5, minimum: 5, maximum: 10 },
    { name: 'offset', type: 'f32', default: 0.04, minimum: 0.02, maximum: 0.06 },
  ],
  build: ({ values }) =>
    buildWheelRim({
      diameter: values.diameter as number,
      width: values.width as number,
      spokes: values.spokes as number,
      offset: values.offset as number,
    }).finish({ key: 'wheel-rim', normals: { mode: 'weighted' } }),
});
