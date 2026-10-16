import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, PointLight, SkyboxBackground, Skylight, perspective } from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('019fb7ce-3a00-7000-8000-000000000000');
const guid = (key: string) => AssetGuid.derive(packageId, key);
const reference = (key: string) => AssetGuid.format(guid(key));
export default definePack({
  schemaVersion: '2.0.0', packageId, name: 'Entity inspector proof',
  sceneComponents: [Camera, ChildOf, DirectionalLight, MeshFilter, MeshRenderer, Name, PointLight, SkyboxBackground, Skylight, Transform],
  build: () => {
    const box = createBoxGeometry(2, 2, 2);
    if (!box.ok) return box;
    return ok({
      'material/surface': Materials.unlit([0.9, 0.25, 0.08, 1]),
      'material/trim': Materials.unlit([0.15, 0.7, 0.3, 1]),
      'mesh/box': { ...box.value, materialSlots: [
        { slotName: 'surface', sourceKey: 'proof:surface', defaultMaterial: guid('material/surface') },
        { slotName: 'trim', sourceKey: 'proof:trim', defaultMaterial: guid('material/trim') },
      ] },
      'scene/proof': { kind: 'scene', entities: {
        box: { components: {
          Name: { value: 'Inspector proof mesh' }, Transform: { pos: [0, 0, 0] },
          MeshFilter: { assetHandle: reference('mesh/box') }, MeshRenderer: { materials: [] },
        } },
        child: { components: {
          ChildOf: { parent: 'box' }, Transform: { pos: [2.5, 0, 0], scale: [0.5, 0.5, 0.5] },
          MeshFilter: { assetHandle: reference('mesh/box') }, MeshRenderer: { materials: [reference('material/trim'), 0] },
        } },
        camera: { components: {
          Name: { value: 'Details proof / camera' }, Transform: { pos: [0, 0, 8] },
          Camera: { ...perspective({ fov: Math.PI / 4, aspect: 4 / 3, near: 0.1, far: 100 }), clearColor: [0.03, 0.06, 0.12, 1] },
        } },
        sun: { components: { Name: { value: 'Details proof / directionalLight' }, Transform: {}, DirectionalLight: { direction: [0, -1, 0], color: [1, 0.85, 0.6], intensity: 3 } } },
        point: { components: { Name: { value: 'Details proof / pointLight' }, Transform: {}, PointLight: { color: [1, 0.8, 0.6], intensity: 2, range: 10 } } },
        ambient: { components: { Name: { value: 'Details proof / skylight' }, Transform: {}, Skylight: { color: [1, 1, 1], intensity: 0.8 } } },
        sky: { components: { Name: { value: 'Details proof / sky' }, Transform: {}, SkyboxBackground: {} } },
        generic: { components: { Name: { value: 'Details proof / entity' }, Transform: {} } },
      } },
    });
  },
});
