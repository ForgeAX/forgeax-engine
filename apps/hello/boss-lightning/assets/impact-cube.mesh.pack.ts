import { createBoxGeometry } from '@forgeax/engine-geometry';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('3c294680-df9c-5160-bbdf-368921f9bc83'),
  name: 'impact-cube',
  build() {
    const mesh = createBoxGeometry(1, 1, 1);
    return mesh.ok ? ok({ 'mesh/impact-cube': mesh.value }) : mesh;
  },
});
