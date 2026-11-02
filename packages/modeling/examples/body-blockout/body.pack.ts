import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildBody } from './body.ts';

/** Case C-105: the mech-gt car body blocked out from three views (`mesh/body-blockout`). */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1051'),
  build: () => buildBody().finish({ key: 'body-blockout', normals: { mode: 'weighted' } }),
});
