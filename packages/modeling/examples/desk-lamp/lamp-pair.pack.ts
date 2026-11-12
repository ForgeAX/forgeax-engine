import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';

const LAMP = AssetGuid.derive(definePackageId('01900000-0000-7000-8000-0000000c0002'), 'mesh/lamp');
const TALL = AssetGuid.derive(definePackageId('01900000-0000-7000-8000-0000000c0003'), 'mesh/lamp');

/**
 * Product reuse (design 10.1, the exception): reads the finished `mesh/lamp` of the
 * lamp Pack and of its tall instance by GUID, lifts both and places them side by side
 * as `mesh/pair`. Lifting keeps triangles, material slots and hard edges but not the
 * upstream tags, labels or n-gons, and this reader is never cached.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0004'),
  build: async ({ readByGuid }) => {
    const lamp = await readByGuid<MeshAsset>(LAMP);
    if (!lamp.ok) return lamp;
    const tall = await readByGuid<MeshAsset>(TALL);
    if (!tall.ok) return tall;
    const m = model();
    m.lift(lamp.value, { label: 'desk', tag: 'lamp' });
    m.translate(sel.createdBy('desk'), [-0.2, 0, 0]);
    m.lift(tall.value, { label: 'tall', tag: 'lamp' });
    m.translate(sel.createdBy('tall'), [0.2, 0, 0]);
    return m.finish({ key: 'pair', normals: { mode: 'weighted' } });
  },
});
