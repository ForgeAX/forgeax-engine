import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildS5Joints } from './s5-joints.ts';

/** C-100 stage S5, mech form: recipe mechanisms on every movable joint of the skeleton, `mesh/s5-joints`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1008'),
  build: () => buildS5Joints().finish({ key: 's5-joints', normals: { mode: 'weighted' } }),
});
