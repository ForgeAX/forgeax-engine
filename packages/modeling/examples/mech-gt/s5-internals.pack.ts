import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildS5Internals } from './s5-chassis.ts';

/** C-100 stage S5: the internal mechanics alone (no body), every part tagged `part:<id>`, `mesh/s5-internals`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1013'),
  build: () => buildS5Internals().finish({ key: 's5-internals', normals: { mode: 'weighted' } }),
});
