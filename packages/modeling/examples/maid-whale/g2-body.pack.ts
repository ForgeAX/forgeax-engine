import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildBody } from './body.ts';

/** C-200 stage G2 (base body, structure-first): `mesh/maid-whale-body`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2012'),
  build: () => buildBody().finish({ key: 'maid-whale-body', normals: { mode: 'weighted' } }),
});
