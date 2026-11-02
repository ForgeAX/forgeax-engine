import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildRim } from './synth-parts.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000f5e02'),
  parameters: [
    { name: 'diameter', type: 'f32', default: 0.4, minimum: 0.36, maximum: 0.44 },
    { name: 'spokes', type: 'u32', default: 5, minimum: 5, maximum: 10 },
  ],
  build: ({ values }) =>
    buildRim({ diameter: values.diameter as number, spokes: values.spokes as number }).finish({
      key: 'rim',
      normals: { mode: 'weighted' },
    }),
});
