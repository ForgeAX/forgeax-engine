import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildS2Body } from './s2-body.ts';

/** C-100 stage S2: the car body block from three views on the S1 frame, `mesh/s2-body`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1006'),
  build: () => buildS2Body().finish({ key: 's2-body', normals: { mode: 'weighted' } }),
});
