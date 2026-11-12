import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildBracket } from './bracket.ts';

/** Case C-010 as an ordinary procedural asset: `mesh/bracket`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0010'),
  parameters: [
    { name: 'length', type: 'f32', default: 0.14, minimum: 0.08, maximum: 0.3 },
    { name: 'height', type: 'f32', default: 0.1, minimum: 0.06, maximum: 0.2 },
    { name: 'thickness', type: 'f32', default: 0.014, minimum: 0.008, maximum: 0.03 },
    { name: 'depth', type: 'f32', default: 0.09, minimum: 0.05, maximum: 0.2 },
    { name: 'fillet', type: 'f32', default: 0.01, minimum: 0.002, maximum: 0.02 },
  ],
  build: ({ values }) =>
    buildBracket({
      length: values.length as number,
      height: values.height as number,
      thickness: values.thickness as number,
      depth: values.depth as number,
      fillet: values.fillet as number,
    }).finish({ key: 'bracket', normals: { mode: 'weighted' } }),
});
