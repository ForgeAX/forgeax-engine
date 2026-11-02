import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildBracket } from './synth-parts.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000f5e01'),
  parameters: [
    { name: 'length', type: 'f32', default: 0.14, minimum: 0.08, maximum: 0.3 },
    { name: 'height', type: 'f32', default: 0.1, minimum: 0.06, maximum: 0.2 },
    { name: 'depth', type: 'f32', default: 0.09, minimum: 0.05, maximum: 0.2 },
  ],
  build: ({ values }) =>
    buildBracket({
      length: values.length as number,
      height: values.height as number,
      depth: values.depth as number,
    }).finish({ key: 'bracket', normals: { mode: 'weighted' } }),
});
