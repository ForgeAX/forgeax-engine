import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { createMeshBuilder } from '@forgeax/engine/geometry';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import { buildWaterPackOutputs, cookWaterAsset } from '@forgeax/engine/water';
import { ok, type MeshAsset, type TerrainSource } from '@forgeax/engine/types';
import { WATER_MESH_DEMO_PACKAGE } from '../src/identity';
import { demoWaveSetSource } from '../../demo-wave-set';
import { standardWaterMaterial } from '../../standard-water-material';

const p = (inputKey: number, x: number, y: number, z: number, width = 5) => ({ inputKey, positionM: [x, y, z] as const, arriveTangentM: [0, 0, 0] as const, leaveTangentM: [0, 0, 0] as const, rotationQuat: [0, 0, 0, 1] as const, up: [0, 1, 0] as const, rollAngle: 0, angleUnit: 'degrees' as const, widthM: width, depthM: 1, velocityMPerSec: 1.4, audioIntensity: 0 });
const ring = (pts: readonly (readonly [number, number])[], linear = false) => pts.map(([x, z], i) => ({
  ...p(i, x, 0.15, z),
  ...(linear ? { interpolationMode: 'linear' as const } : {}),
}));
export default definePack({
  schemaVersion: '2.0.0', packageId: WATER_MESH_DEMO_PACKAGE, name: 'Water Mesh R2 Lab',
  build: async ({ packageId, readByGuid }) => {
    const g = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const zoneGuid = g('zone/main');
    const transitionLake = g('material/transition-lake');
    const transitionOcean = g('material/transition-ocean');
    const waveSetGuid = g('waves/seed-731-v1');
    const lagoonWaveSetGuid = g('waves/lagoon-calm-v1');
    const cookedWaves = cookWaterAsset(demoWaveSetSource());
    if (!cookedWaves.ok) return cookedWaves;
    const cookedLagoonWaves = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: { kind: 'predefined', waves: [
        { directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.07, steepness: 0.02 },
        { directionXZ: [0, 1], wavelengthM: 4, amplitudeM: 0.03, steepness: 0.01 },
      ] },
      depthMaskM: 2, maxWaveHeightM: 0.2, timeSource: 'scene-clock',
    });
    if (!cookedLagoonWaves.ok) return cookedLagoonWaves;
    const zone = {
      kind: 'water-zone' as const, extentM: { spanXM: 192, spanZM: 192 }, tileSizeM: 8,
      tessellationFactor: 8, lodScale: 1.7,
      waterInfo: { resolution: { widthPx: 256, heightPx: 256 }, format: 'rgba16f' as const, blurRadius: 2, localTessellation: false },
      farExtentM: { spanXM: 2600, spanZM: 2600 }, farMaterialGuid: g('material/ocean'),
    };
    const body = (type: 'river' | 'lake' | 'ocean', points: ReturnType<typeof ring>, priority: number, material: string) => ({
      kind: 'water-body' as const, type, zoneGuid, waveSetGuid,
      spline: { closed: type !== 'river', interpolationVersion: 'ue-water-spline/1' as const, points },
      baseHeightM: type === 'river' ? 0.12 : type === 'lake' ? 0.2 : 0.1,
      overlapPriority: priority, maxWaveHeightM: 3,
      surfaceMaterialGuid: material,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      collision: { type: 'none' as const, enabled: false },
      queryFootprint: type === 'river' ? [[-37, -4], [37, -4], [37, 4], [-37, 4]] : type === 'lake' ? [[-17, -13], [17, -13], [17, 13], [-17, 13]] : [[-15, -11], [15, -11], [15, 11], [-15, 11]],
      ...(type === 'ocean' ? { oceanExtentM: [2048, 2048] as const, centerOnWaterZone: false } : {}),
      ...(type === 'river' ? { riverToLakeTransitionMaterialGuid: transitionLake, riverToOceanTransitionMaterialGuid: transitionOcean } : {}),
    });
    const islandAngles = Array.from({ length: 24 }, (_, index) => index * Math.PI / 12);
    const outerOutline = (offsetM: number) => islandAngles.map((angle) => {
      const shape = 1 + 0.08 * Math.sin(3 * angle + 0.4) + 0.05 * Math.cos(5 * angle - 0.7);
      return [26 + (18 * shape + offsetM) * Math.cos(angle), 20 + (16 * shape + offsetM) * Math.sin(angle)] as const;
    });
    const lagoonOutline = (offsetM: number) => islandAngles.map((angle) => {
      const shape = 1 + 0.06 * Math.sin(3 * angle - 0.8);
      return [25 + (6.5 * shape + offsetM) * Math.cos(angle), 20.5 + (5.5 * shape + offsetM) * Math.sin(angle)] as const;
    });
    // The shore foot extends 2 m past the Ocean hole, beyond this WaveSet's 1.31 m horizontal displacement bound.
    const islandRings = [
      outerOutline(2).map(([x, z]) => [x, -0.15, z]),
      outerOutline(-0.7).map(([x, z]) => [x, 0.45, z]),
      outerOutline(-4.5).map(([x, z], index) => [x, 4.1 + 0.55 * Math.sin(islandAngles[index]! * 3 + 0.3), z]),
      lagoonOutline(1.2).map(([x, z]) => [x, 0.55, z]),
      lagoonOutline(-1.5).map(([x, z]) => [x, -1.5, z]),
    ];
    const verticesPerRing = islandAngles.length;
    const ringVertices = new Float32Array([...islandRings.flatMap((vertices) => vertices.flat()), 25, -1.5, 20.5]);
    const ringIndices: number[] = [];
    for (let ringIndex = 0; ringIndex < islandRings.length - 1; ringIndex++) {
      const outer = ringIndex * verticesPerRing, inner = outer + verticesPerRing;
      for (let side = 0; side < verticesPerRing; side++) {
        const next = (side + 1) % verticesPerRing;
        ringIndices.push(outer + side, inner + next, outer + next, outer + side, inner + side, inner + next);
      }
    }
    const basin = (islandRings.length - 1) * verticesPerRing;
    const basinCenter = islandRings.length * verticesPerRing;
    for (let side = 0; side < verticesPerRing; side++) {
      ringIndices.push(basinCenter, basin + (side + 1) % verticesPerRing, basin + side);
    }
    const ringMesh = createMeshBuilder({
      attributes: { position: ringVertices },
      indices: ringIndices,
    }).build().unwrap();
    const islandLandMaterial = standardWaterMaterial([0.1, 0.34, 0.22, 1], 0.85);
    const islandFoot = islandRings[0]!;
    const groundHeight = (x: number, z: number) => {
      for (let index = 0; index < ringIndices.length; index += 3) {
        const a = ringIndices[index]! * 3, b = ringIndices[index + 1]! * 3, c = ringIndices[index + 2]! * 3;
        const ax = ringVertices[a]!, az = ringVertices[a + 2]!;
        const bx = ringVertices[b]!, bz = ringVertices[b + 2]!;
        const cx = ringVertices[c]!, cz = ringVertices[c + 2]!;
        const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(denominator) < 1e-8) continue;
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
        const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
        if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
          return u * ringVertices[a + 1]! + v * ringVertices[b + 1]! + (1 - u - v) * ringVertices[c + 1]!;
      }
      let distanceSquared = Number.POSITIVE_INFINITY;
      for (let index = 0; index < islandFoot.length; index++) {
        const [ax, , az] = islandFoot[index]!;
        const [bx, , bz] = islandFoot[(index + 1) % islandFoot.length]!;
        const dx = bx! - ax!, dz = bz! - az!;
        const along = Math.max(0, Math.min(1, ((x - ax!) * dx + (z - az!) * dz) / (dx * dx + dz * dz)));
        distanceSquared = Math.min(distanceSquared, (x - ax! - along * dx) ** 2 + (z - az! - along * dz) ** 2);
      }
      return -0.15 - Math.min(8, 0.8 * Math.sqrt(distanceSquared));
    };
    const terrainColumns = 91, terrainSpacingM = 0.8;
    const terrainHeights = new Float32Array(terrainColumns * terrainColumns);
    for (let row = 0; row < terrainColumns; row++) for (let column = 0; column < terrainColumns; column++)
      terrainHeights[row * terrainColumns + column] = groundHeight(-10 + column * terrainSpacingM, -16 + row * terrainSpacingM);
    const terrainSource: TerrainSource = {
      columns: terrainColumns, rows: terrainColumns, spacing: terrainSpacingM, subsectionVertices: 16,
      heights: terrainHeights, weights: new Float32Array(terrainHeights.length).fill(1),
      layers: [{ material: g('material/island-land'), blend: 'weight' }],
    };
    const islandTerrain = buildTerrainAssets(terrainSource, (key) => g(`terrain/island/${key}`), { [g('material/island-land')]: islandLandMaterial });
    if (!islandTerrain.ok) return islandTerrain;
    const ringMeshGuid = g('mesh/island-ring');
    const built = await buildWaterPackOutputs({
      'zone/main': zone,
      'body/river': body('river', [p(0, -42, 0, -26), p(1, -20, 0.1, -13), p(2, 1, 0.2, -5), p(3, 26, 0.25, 8), p(4, 44, 0.3, 19)], 1, g('material/river')),
      'body/lake': body('lake', ring([[-17, -13], [17, -13], [17, 13], [-17, 13]]), 2, g('material/lake')),
      'body/ocean': body('ocean', ring([[600, 600], [620, 600], [620, 620], [600, 620]]), 3, g('material/ocean')),
      'body/island-ocean': body('ocean', ring(outerOutline(0), true), 3, g('material/ocean')),
      'body/lagoon': { ...body('lake', ring(lagoonOutline(0), true), 5, g('material/lagoon')), waveSetGuid: lagoonWaveSetGuid, maxWaveHeightM: 0.2 },
    }, { packageId, readByGuid: async (requested) => {
      const normalized = AssetGuid.format(requested).toLowerCase();
      if (normalized === ringMeshGuid.toLowerCase()) return ok(ringMesh as MeshAsset);
      if (normalized === waveSetGuid.toLowerCase()) return ok(cookedWaves.value);
      if (normalized === lagoonWaveSetGuid.toLowerCase()) return ok(cookedLagoonWaves.value);
      return readByGuid(requested);
    } });
    if (!built.ok) return built;
    return ok({ ...built.value,
      ...Object.fromEntries(Object.entries(islandTerrain.value).map(([key, asset]) => [`terrain/island/${key}`, asset])),
      'material/river': standardWaterMaterial([0.025, 0.24, 0.29, 1], 0.15), 'material/lake': standardWaterMaterial([0.04, 0.2, 0.42, 1], 0.18),
      'material/ocean': standardWaterMaterial([0.02, 0.11, 0.3, 1], 0.12), 'material/transition-lake': standardWaterMaterial([0.08, 0.36, 0.28, 1], 0.16),
      'material/transition-ocean': standardWaterMaterial([0.03, 0.27, 0.39, 1], 0.13),
      'material/lagoon': standardWaterMaterial([0.03, 0.35, 0.37, 1], 0.24),
      'material/island-land': islandLandMaterial, 'mesh/island-ring': ringMesh,
      'waves/seed-731-v1': cookedWaves.value, 'waves/lagoon-calm-v1': cookedLagoonWaves.value,
    });
  },
});
