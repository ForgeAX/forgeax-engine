import { createBoxGeometry } from '@forgeax/engine/geometry';
import { definePack } from '@forgeax/engine/pack/source';
import type { AssetGuid, MeshAsset } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, PACKAGE_IDS, RUSTED_IRON_MATERIAL_GUID } from './shared/asset-refs.ts';

function withMaterial(mesh: MeshAsset, material: AssetGuid, sourceKey: string): MeshAsset {
  return {
    ...mesh,
    materialSlots: [{ slotName: 'surface', sourceKey, defaultMaterial: material }],
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.geometry,
  name: 'Game 3D / Geometry',
  build: () => {
    const ground = createBoxGeometry(28, 0.4, 28);
    if (!ground.ok) return ground;
    const cube = createBoxGeometry(1.5, 1.5, 1.5);
    if (!cube.ok) return cube;
    const ramp = createBoxGeometry(3.2, 0.3, 4.4);
    if (!ramp.ok) return ramp;
    return ok({
      'mesh/ground': withMaterial(ground.value, assetGuid(PACKAGE_IDS.materials, 'material/ground'), 'game-3d:ground'),
      'mesh/cube': withMaterial(cube.value, assetGuid(PACKAGE_IDS.materials, 'material/painted'), 'game-3d:cube'),
      'mesh/ramp': withMaterial(ramp.value, RUSTED_IRON_MATERIAL_GUID, 'game-3d:ramp'),
    });
  },
});
