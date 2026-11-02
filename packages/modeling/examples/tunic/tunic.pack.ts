import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildTunic } from './tunic.ts';

/** Case C-113 (artist editing tools): `mesh/tunic`, a torso with a bodice and a skirt. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0113'),
  build: () => buildTunic().finish({ key: 'tunic', normals: { mode: 'weighted' } }),
});
