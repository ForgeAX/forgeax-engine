import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildS5Chassis } from './s5-chassis.ts';

/** C-100 stage S5, car form: chassis, suspension, powertrain and harness inside the S2 body, `mesh/s5-chassis`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1007'),
  build: () => buildS5Chassis().finish({ key: 's5-chassis', normals: { mode: 'weighted' } }),
});
