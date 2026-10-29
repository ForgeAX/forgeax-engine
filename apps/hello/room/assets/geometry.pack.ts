import { createBoxGeometry } from '@forgeax/engine-geometry';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('019fc0e7-2000-7000-8000-000000000001'),
  name: 'hello-room geometry',
  build: () => {
    const cube = createBoxGeometry(1, 1, 1);
    return cube.ok ? ok({ 'mesh/cube': cube.value }) : cube;
  },
});
