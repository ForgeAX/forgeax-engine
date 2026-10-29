import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import { Name, Transform } from '@forgeax/engine/scene';
import { ok } from '@forgeax/engine/types';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('019fb7ce-3900-7000-8000-000000000000'),
  name: 'Pack authoring',
  sceneComponents: [Camera, DirectionalLight, MeshFilter, MeshRenderer, Name, Transform],
  parameters: [
    { name: 'radius', type: 'f32', default: 1, minimum: 0.1, maximum: 3 },
    { name: 'bodyColor', type: 'color', default: [0.9, 0.25, 0.08, 1], apply: { asset: 'material/box', path: ['values', 'baseColor'] } },
    { name: 'sunColor', type: 'vec3', default: [1, 1, 1], apply: { asset: 'scene/proof', path: ['entities', 'sun', 'components', 'DirectionalLight', 'color'] } },
  ],
  build({ packageId, values }) {
    const box = createBoxGeometry(values.radius * 2, values.radius * 2, values.radius * 2);
    if (!box.ok) return box;
    const guid = (key: string) => AssetGuid.derive(packageId, key);
    const material = Materials.unlit([1, 1, 1, 1]);
    const { baseColor: _factoryColor, ...materialValues } = material.values ?? {};
    return ok({
      'material/box': { ...material, values: materialValues },
      'mesh/box': { ...box.value, materialSlots: [{ slotName: 'surface', sourceKey: 'proof:box', defaultMaterial: guid('material/box') }] },
      'scene/proof': { kind: 'scene', entities: {
        box: { components: { Name: { value: 'Editable cube' }, Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: AssetGuid.format(guid('mesh/box')) }, MeshRenderer: { materials: [] } } },
        sun: { components: { Name: { value: 'Editable sun' }, Transform: {}, DirectionalLight: { direction: [0, -1, -1], intensity: 2 } } },
        camera: { components: { Name: { value: 'Preview camera' }, Transform: { pos: [0, 0, 6] }, Camera: { ...perspective({ fov: Math.PI / 4, aspect: 4 / 3, near: 0.1, far: 100 }), clearColor: [0.03, 0.06, 0.12, 1] } } },
      } },
    });
  },
});
