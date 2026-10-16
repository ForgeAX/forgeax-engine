import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import { Name, Transform } from '@forgeax/engine/scene';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('019fb7ce-3900-7000-8000-000000000000');
const guid = (key: string) => AssetGuid.derive(packageId, key);
export default definePack({
  schemaVersion: '2.0.0', packageId, name: 'Workspace lifecycle proof',
  sceneComponents: [Camera, MeshFilter, MeshRenderer, Name, Transform],
  build: () => {
    const box = createBoxGeometry(2, 2, 2);
    if (!box.ok) return box;
    return ok({
      'material/box': Materials.unlit([0.9, 0.25, 0.08, 1]),
      'mesh/box': { ...box.value, materialSlots: [{ slotName: 'surface', sourceKey: 'proof:box', defaultMaterial: guid('material/box') }] },
      'scene/proof': { kind: 'scene', entities: {
        box: { components: { Name: { value: 'Lifecycle proof cube' }, Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: AssetGuid.format(guid('mesh/box')) }, MeshRenderer: { materials: [] } } },
        camera: { components: { Name: { value: 'Proof camera' }, Transform: { pos: [0, 0, 6] }, Camera: { ...perspective({ fov: Math.PI / 4, aspect: 4 / 3, near: 0.1, far: 100 }), clearColor: [0.03, 0.06, 0.12, 1] } } },
      } },
    });
  },
});
