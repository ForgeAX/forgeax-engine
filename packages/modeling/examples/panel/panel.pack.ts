import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildPanel } from './panel.ts';

/**
 * Case C-011 as an ordinary procedural asset, `mesh/panel`: every boolean runs as a
 * compute job on the TypeScript baseline inside the Pack build.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0011'),
  parameters: [
    { name: 'width', type: 'f32', default: 0.32, minimum: 0.28, maximum: 0.4 },
    { name: 'depth', type: 'f32', default: 0.2, minimum: 0.18, maximum: 0.26 },
    { name: 'thickness', type: 'f32', default: 0.012, minimum: 0.008, maximum: 0.016 },
  ],
  build: ({ values }) =>
    buildPanel({
      width: values.width as number,
      depth: values.depth as number,
      thickness: values.thickness as number,
    }).finish({ key: 'panel', normals: { mode: 'weighted' } }),
});
