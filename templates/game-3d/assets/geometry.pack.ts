import {
  createBoxGeometry,
  createCylinderGeometry,
  createSphereGeometry,
  createTorusGeometry,
} from '@forgeax/engine/geometry';
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
    const sphere = createSphereGeometry(0.9, 48, 32);
    if (!sphere.ok) return sphere;
    const pedestal = createCylinderGeometry(0.75, 0.9, 1, 32, 1);
    if (!pedestal.ok) return pedestal;
    const torus = createTorusGeometry(1, 0.24, 20, 64);
    if (!torus.ok) return torus;
    const light = createSphereGeometry(0.13, 16, 10);
    if (!light.ok) return light;
    const step = createBoxGeometry(2.4, 0.45, 2.4);
    if (!step.ok) return step;
    const ramp = createBoxGeometry(3.2, 0.3, 4.4);
    if (!ramp.ok) return ramp;
    return ok({
      'mesh/ground': withMaterial(ground.value, assetGuid(PACKAGE_IDS.materials, 'material/ground'), 'game-3d:ground'),
      'mesh/cube': withMaterial(cube.value, assetGuid(PACKAGE_IDS.materials, 'material/painted'), 'game-3d:cube'),
      'mesh/sphere': withMaterial(sphere.value, assetGuid(PACKAGE_IDS.materials, 'material/metal'), 'game-3d:sphere'),
      'mesh/pedestal': withMaterial(pedestal.value, assetGuid(PACKAGE_IDS.materials, 'material/white'), 'game-3d:pedestal'),
      'mesh/torus': withMaterial(torus.value, assetGuid(PACKAGE_IDS.materials, 'material/metal'), 'game-3d:torus'),
      'mesh/light': withMaterial(light.value, assetGuid(PACKAGE_IDS.materials, 'material/light'), 'game-3d:light'),
      'mesh/step': withMaterial(step.value, assetGuid(PACKAGE_IDS.materials, 'material/obstacle'), 'game-3d:step'),
      'mesh/ramp': withMaterial(ramp.value, RUSTED_IRON_MATERIAL_GUID, 'game-3d:ramp'),
    });
  },
});
