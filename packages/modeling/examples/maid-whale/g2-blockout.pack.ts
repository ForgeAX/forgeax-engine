import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildBlockout } from './blockout.ts';

/** C-200 stage G2 (blockout): `mesh/maid-whale-g2`, every part's primary form from the G1 data. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2002'),
  build: () => buildBlockout().finish({ key: 'maid-whale-g2', normals: { mode: 'weighted' } }),
});
