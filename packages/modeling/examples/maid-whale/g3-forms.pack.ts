import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildForms } from './forms.ts';

/** C-200 stage G3 (secondary forms): `mesh/maid-whale-g3`, G2 with the refined parts. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2003'),
  build: () => buildForms().finish({ key: 'maid-whale-g3', normals: { mode: 'weighted' } }),
});
