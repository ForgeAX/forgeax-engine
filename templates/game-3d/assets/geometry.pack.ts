import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine/geometry';
import { definePack } from '@forgeax/engine/pack/source';
import type { AssetGuid, MeshAsset } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS, RUSTED_IRON_MATERIAL_GUID } from './shared/asset-refs.ts';

function withMaterial(mesh: MeshAsset, material: AssetGuid, sourceKey: string): MeshAsset {
  return {
    ...mesh,
    materialSlots: [{ slotName: 'surface', sourceKey, defaultMaterial: material }],
  };
}

export function generateIronSphere() {
  const sphere = createSphereGeometry(1, 48, 32);
  if (!sphere.ok) return sphere;
  return ok({
    'mesh/iron-sphere': withMaterial(sphere.value, RUSTED_IRON_MATERIAL_GUID, 'game-3d:iron-sphere'),
  });
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.geometry,
  name: 'Game 3D / Geometry',
  runtime: {
    export: 'generateIronSphere',
    outputs: { 'mesh/iron-sphere': 'mesh' },
    dependencies: [guidText(RUSTED_IRON_MATERIAL_GUID)],
  },
  build: () => {
    const ground = createBoxGeometry(2000, 0.4, 2000);
    if (!ground.ok) return ground;
    return ok({
      'mesh/ground': withMaterial(ground.value, assetGuid(PACKAGE_IDS.materials, 'material/ground'), 'game-3d:ground'),
    });
  },
});
