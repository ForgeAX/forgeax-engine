import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildMechFrame } from './proportions.ts';

/** C-100 stage S1, mech form: the `joints.json` skeleton frame `mesh/mech-frame`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1002'),
  build: () => buildMechFrame().finish({ key: 'mech-frame', normals: { mode: 'weighted' } }),
});
