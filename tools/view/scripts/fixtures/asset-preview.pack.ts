import { buildMeshCollision, createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('019fb7ce-3a00-7000-8000-000000000021');
export default definePack({
  schemaVersion: '2.0.0', packageId, name: 'Asset preview proof',
  build() {
    const box = createBoxGeometry(2, 3, 4).unwrap();
    const mesh = { ...box, materialSlots: [{ slotName: 'Surface', defaultMaterial: AssetGuid.derive(packageId, 'material/red') }] };
    const data = new Uint8Array(8 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = i % 32 < 16 ? 240 : 20; data[i + 1] = 70; data[i + 2] = 160; data[i + 3] = 255; }
    return ok({
      'material/red': Materials.unlit([0.9, 0.05, 0.03, 1]),
      'mesh/collision': { ...mesh, collision: buildMeshCollision(mesh).unwrap() },
      'mesh/plain': mesh,
      'texture/checker': { kind: 'texture', shape: { viewDimension: '2d', extent: { width: 8, height: 4 } }, format: 'rgba8unorm', colorSpace: 'linear', mips: { kind: 'none' }, data },
    });
  },
});
