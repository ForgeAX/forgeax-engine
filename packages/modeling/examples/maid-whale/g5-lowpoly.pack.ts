import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildLowpoly } from './lowpoly.ts';

/** C-200 stage G5 (low-poly faceting): `mesh/maid-whale-g5`, triangulated, flat normals. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2005'),
  build: () => buildLowpoly().finish({ key: 'maid-whale-g5', normals: { mode: 'flat' } }),
});
