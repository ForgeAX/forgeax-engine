import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildCarMechanisms } from './mechanics.ts';

/** C-100 stage S4, car form: hinge and slide placeholders at the transform.json anchors, `mesh/car-mechanisms`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1005'),
  build: () => buildCarMechanisms().finish({ key: 'car-mechanisms', normals: { mode: 'weighted' } }),
});
