import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
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
    const uv = box.value.attributes.uv as Float32Array;
    const uv1 = Float32Array.from(uv, (value, index) => {
      const face = Math.floor(index / 8);
      return ((index % 2 ? Math.floor(face / 2) : face % 2) + 0.08 + value * 0.84) / 3;
    });
    const uv2 = Float32Array.from(uv, (value, index) => index % 2 ? value * 0.5 + 0.25 : value * 1.25);
    const attributes = { ...box.value.attributes, uv1, uv2 };
    const packed = packInterleavedVertexAttributes(attributes, 24);
    if (!packed.ok) return packed;
    const mesh = { ...box.value, vertices: packed.value.vertices, attributes };
    const dense = createBoxGeometry(2, 2, 2, 64, 64, 64);
    if (!dense.ok) return dense;
    return ok({
      'material/box': Materials.unlit([0.9, 0.25, 0.08, 1]),
      'mesh/box': { ...mesh, materialSlots: [{ slotName: 'surface', sourceKey: 'proof:box', defaultMaterial: guid('material/box') }] },
      'mesh/dense': { ...dense.value, materialSlots: [{ slotName: 'surface', defaultMaterial: guid('material/box') }] },
      'texture/navigation': { kind: 'texture', shape: { viewDimension: '2d', extent: { width: 2, height: 2 } }, format: 'rgba8unorm-srgb', colorSpace: 'srgb', mips: { kind: 'none' }, data: new Uint8Array([240, 40, 30, 255, 30, 200, 60, 255, 30, 80, 240, 255, 240, 210, 30, 255]) },
      'material/navigation': Materials.unlit([1, 1, 1, 1], { baseColorTexture: AssetGuid.format(guid('texture/navigation')) }),
      'scene/proof': { kind: 'scene', entities: {
        box: { components: { Name: { value: 'Lifecycle proof cube' }, Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: AssetGuid.format(guid('mesh/box')) }, MeshRenderer: { materials: [] } } },
        camera: { components: { Name: { value: 'Proof camera' }, Transform: { pos: [0, 0, 6] }, Camera: { ...perspective({ fov: Math.PI / 4, aspect: 4 / 3, near: 0.1, far: 100 }), clearColor: [0.03, 0.06, 0.12, 1] } } },
      } },
    });
  },
});
