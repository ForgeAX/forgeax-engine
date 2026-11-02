import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildMechHardware } from './mechanics.ts';

/** C-100 stage S4, mech form: the S1 skeleton with placeholder hardware on every joint, `mesh/mech-hardware`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1004'),
  build: () => buildMechHardware().finish({ key: 'mech-hardware', normals: { mode: 'weighted' } }),
});
