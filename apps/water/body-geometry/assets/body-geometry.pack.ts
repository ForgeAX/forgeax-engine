import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';
import { buildWaterPackOutputs } from '@forgeax/engine/water';
import { standardWaterMaterial } from '../../standard-water-material';
import { WATER_BODY_GEOMETRY_PACKAGE_NAMESPACE } from '../src/identity';

const point = (inputKey: number, x: number, z: number, widthM = 4, depthM = 0.8) => ({
  inputKey,
  positionM: [x, 0.2, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM,
  depthM,
  velocityMPerSec: 1,
  audioIntensity: 0,
});
const ring = (positions: readonly (readonly [number, number])[]) =>
  positions.map(([x, z], index) => ({
    ...point(index, x, z),
    interpolationMode: 'linear' as const,
    rotationQuat: [0, 0, 0, 1] as const,
  }));
const geometryMaterial = (
  baseColor: readonly [number, number, number, number],
  roughness: number,
) =>
  Materials.standard({
    surfaceModule: 'water_r1::geometry_surface',
    colorSpace: 'linear',
    parameters: [
      { name: 'baseColor', type: 'color' },
      { name: 'roughness', type: 'f32' },
    ],
    values: { baseColor, roughness },
  });
const river = {
  kind: 'water-body' as const,
  type: 'river' as const,
  spline: {
    closed: false,
    interpolationVersion: 'ue-water-spline/1' as const,
    points: [
      {
        inputKey: 0,
        positionM: [-8, 0.15, -3] as const,
        arriveTangentM: [9, 0, 0] as const,
        leaveTangentM: [9, 0, 0] as const,
        rotationQuat: [0, 0, 0, 1] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 3.5,
        depthM: 0.8,
        velocityMPerSec: 1.2,
        audioIntensity: 0,
      },
      {
        inputKey: 1,
        positionM: [0, 0.35, 0] as const,
        arriveTangentM: [8, 1, 3] as const,
        leaveTangentM: [8, 1, 3] as const,
        rotationQuat: [0, 0, 0, 1] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 5.5,
        depthM: 1.1,
        velocityMPerSec: 1.4,
        audioIntensity: 0,
      },
      {
        inputKey: 2,
        positionM: [8, 0.5, 5] as const,
        arriveTangentM: [9, 0, 0] as const,
        leaveTangentM: [9, 0, 0] as const,
        rotationQuat: [0, 0, 0, 1] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 4.25,
        depthM: 0.9,
        velocityMPerSec: 1.1,
        audioIntensity: 0,
      },
    ],
  },
  baseHeightM: 0,
  overlapPriority: 0,
  maxWaveHeightM: 0.1,
  surfaceMaterialGuid: '',
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'river-prism' as const, enabled: true },
  queryFootprint: [
    [-8, -5],
    [8, -5],
    [8, 8],
    [-8, 1],
  ],
};
const lake = {
  kind: 'water-body' as const,
  type: 'lake' as const,
  spline: {
    closed: true,
    interpolationVersion: 'ue-water-spline/1' as const,
    points: ring([
      [-3.5, -3],
      [3.5, -3],
      [3.5, 3],
      [-3.5, 3],
    ]),
  },
  baseHeightM: 0.25,
  overlapPriority: 1,
  maxWaveHeightM: 0.08,
  surfaceMaterialGuid: '',
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'polygon' as const, enabled: true, channelDepthM: 3 },
  queryFootprint: [
    [-3.5, -3],
    [3.5, -3],
    [3.5, 3],
    [-3.5, 3],
  ],
};
const ocean = {
  kind: 'water-body' as const,
  type: 'ocean' as const,
  spline: {
    closed: true,
    interpolationVersion: 'ue-water-spline/1' as const,
    points: ring([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]),
  },
  baseHeightM: 0,
  overlapPriority: 2,
  maxWaveHeightM: 0.3,
  surfaceMaterialGuid: '',
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: {
    type: 'polygon' as const,
    enabled: true,
    collisionHalfHeightM: 20,
    collisionHalfExtentsM: [6, 4] as const,
  },
  queryFootprint: [
    [-7, -5],
    [7, -5],
    [7, 5],
    [-7, 5],
  ],
  oceanExtentM: [14, 10] as const,
  centerOnWaterZone: false,
};
const customMesh = createBoxGeometry(5.5, 0.16, 5.5).unwrap();
const customMeshSourceKey = 'mesh/custom-platform';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_BODY_GEOMETRY_PACKAGE_NAMESPACE,
  name: 'Water Body Geometry',
  build: async ({ packageId, readByGuid }) => {
    const materialKeys = ['river', 'lake', 'ocean', 'custom'] as const;
    const materialGuids = Object.fromEntries(
      materialKeys.map((key) => [
        key,
        AssetGuid.format(AssetGuid.derive(packageId, `material/${key}`)),
      ]),
    );
    const customMeshGuid = AssetGuid.format(AssetGuid.derive(packageId, customMeshSourceKey));
    const water = await buildWaterPackOutputs(
      {
        'body/river': { ...river, surfaceMaterialGuid: materialGuids.river },
        'body/lake': { ...lake, surfaceMaterialGuid: materialGuids.lake },
        'body/ocean': { ...ocean, surfaceMaterialGuid: materialGuids.ocean },
        'body/custom': {
          kind: 'water-body',
          type: 'custom',
          spline: { closed: false, points: [point(0, -1.8, 0), point(1, 1.8, 0)] },
          baseHeightM: 0.1,
          overlapPriority: 3,
          maxWaveHeightM: 0,
          surfaceMaterialGuid: materialGuids.custom,
          customMeshOverrideGuid: customMeshGuid,
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'custom-mesh', enabled: true, meshGuid: customMeshGuid },
          queryFootprint: [
            [-2.75, -2.75],
            [2.75, -2.75],
            [2.75, 2.75],
            [-2.75, 2.75],
          ],
        },
      },
      {
        packageId,
        readByGuid: async (guid) =>
          AssetGuid.format(guid).toLowerCase() === customMeshGuid.toLowerCase()
            ? ok(customMesh)
            : readByGuid(guid),
      },
    );
    if (!water.ok) return water;
    return ok({
      ...water.value,
      [customMeshSourceKey]: customMesh,
      'material/river': geometryMaterial([0.025, 0.22, 0.28, 1], 0.22),
      'material/lake': standardWaterMaterial([0.03, 0.25, 0.22, 1], 0.18),
      'material/ocean': standardWaterMaterial([0.025, 0.13, 0.22, 1], 0.15),
      'material/custom': standardWaterMaterial([0.09, 0.29, 0.32, 1], 0.2),
    });
  },
});
