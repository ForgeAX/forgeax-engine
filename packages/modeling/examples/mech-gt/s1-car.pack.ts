import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildCarFrame } from './proportions.ts';

/** C-100 stage S1, car form: the proportion frame `mesh/car-frame` from public dimensions. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1001'),
  build: () => buildCarFrame().finish({ key: 'car-frame', normals: { mode: 'weighted' } }),
});
