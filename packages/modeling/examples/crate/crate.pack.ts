import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildCrate } from './crate.ts';

/** Case C-001 as an ordinary procedural asset: `mesh/crate`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0001'),
  parameters: [
    { name: 'width', type: 'f32', default: 0.8, minimum: 0.4, maximum: 2 },
    { name: 'height', type: 'f32', default: 0.5, minimum: 0.3, maximum: 1.5 },
    { name: 'depth', type: 'f32', default: 0.5, minimum: 0.3, maximum: 1.5 },
  ],
  build: ({ values }) =>
    buildCrate({
      width: values.width as number,
      height: values.height as number,
      depth: values.depth as number,
    }).finish({ key: 'crate', normals: { mode: 'weighted' } }),
});
