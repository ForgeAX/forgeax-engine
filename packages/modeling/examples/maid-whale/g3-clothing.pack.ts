import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildDressed } from './garments.ts';

/** C-200 stage G3 (clothing layers over the G2 body): `mesh/maid-whale-dressed`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2013'),
  build: () => buildDressed().finish({ key: 'maid-whale-dressed', normals: { mode: 'weighted' } }),
});
