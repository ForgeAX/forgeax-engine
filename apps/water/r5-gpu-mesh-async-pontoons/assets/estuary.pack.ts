import { EngineContent } from '@forgeax/engine/content';
import { createBoxGeometry, createMeshBuilder, createSphereGeometry } from '@forgeax/engine/geometry';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { Collider, RigidBody } from '@forgeax/engine/physics';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { ChildOf, Name, Transform, WaterBodyInstance, WaterPontoonSet, WaterTerrainProvider, WaterZoneInstance } from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import { ok, standardSurfaceParameters, type MaterialRootAsset, type SceneAsset, type SceneEntity, type WaterBodySource } from '@forgeax/engine/types';
import { buildWaterPackOutputs, cookWaterAsset, waterMaterialFamilySlots } from '@forgeax/engine/water';
import { CRAFTS, START_POSITIONS, WATER_R5_PACKAGE, pontoonLayout } from '../src/identity';

function material(color: readonly [number, number, number, number], roughness = .6, metallic = 0): MaterialRootAsset {
  return { kind: 'material', colorSpace: 'linear', parameters: standardSurfaceParameters([]), values: { baseColor: color, roughness, metallic },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }] };
}
const point = (key: number, x: number, z: number, y = 0, width = 13) => ({ inputKey: key, interpolationMode: 'linear' as const,
  positionM: [x, y, z] as const, arriveTangentM: [0, 0, 0] as const, leaveTangentM: [0, 0, 0] as const,
  rotationQuat: [0, 0, 0, 1] as const, up: [0, 1, 0] as const, rollAngle: 0, angleUnit: 'degrees' as const,
  widthM: width, depthM: 5, velocityMPerSec: 1.3, audioIntensity: 1 });
export function hull() {
  const outline = [[-2, -.92], [1.2, -.92], [2.45, -.35], [2.6, 0], [2.45, .35], [1.2, .92], [-2, .92]];
  const positions: number[] = [], indices: number[] = [], n = outline.length;
  for (const y of [-.4, .22]) for (const [x, z] of outline) positions.push(x!, y, z!);
  for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1, n, n + i + 1, n + i);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; indices.push(i, n + j, j, i, n + i, n + j); }
  return createMeshBuilder({ attributes: { position: new Float32Array(positions) }, indices }).build().unwrap();
}

export default definePack({ schemaVersion: '2.0.0', packageId: WATER_R5_PACKAGE, name: 'Water R5 Estuary',
  sceneComponents: [Name, Transform, ChildOf, MeshFilter, MeshRenderer, RigidBody, Collider, WaterPontoonSet, WaterBodyInstance, WaterZoneInstance, Terrain, WaterTerrainProvider],
  build: async ({ packageId, readByGuid }) => {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const waves = cookWaterAsset({ kind: 'water-wave-set', waveSource: { kind: 'predefined', waves: [
      { directionXZ: [.8, .6], wavelengthM: 10, amplitudeM: .23, steepness: .13 },
      { directionXZ: [-.4, .916515], wavelengthM: 4, amplitudeM: .075, steepness: .08 },
    ] }, depthMaskM: 3, maxWaveHeightM: .32, timeSource: 'scene-clock' }).unwrap();
    const off = cookWaterAsset({ kind: 'water-wave-set', waveSource: { kind: 'predefined', waves: [{ directionXZ: [1, 0], wavelengthM: 10, amplitudeM: 0, steepness: 0 }] }, depthMaskM: 3, maxWaveHeightM: 0, timeSource: 'scene-clock' }).unwrap();
    const family = { guids: EngineContent.water.materials }, zoneGuid = guid('zone/estuary');
    const common = { kind: 'water-body' as const, zoneGuid, baseHeightM: 0, overlapPriority: 1, maxWaveHeightM: .32, waveSetGuid: guid('waves/estuary'), shapeDilationM: 1,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false }, queryFootprint: [[-120, -100], [120, -100], [120, 100], [-120, 100]] as const,
      underwaterSettings: { enabled: true, priority: 0, blendRadiusM: 1, blendWeight: 1, maxDepthM: 12 } };
    const river: WaterBodySource = { ...common, type: 'river', overlapPriority: 3, ...waterMaterialFamilySlots(family, 'river'),
      spline: { closed: false, interpolationVersion: 'ue-water-spline/1', points: [point(0, -91, -22, .14, 12), point(1, -63, -15, .1, 13), point(2, -37, -4, .06, 15), point(3, -15, 0, .04, 19)] },
      collision: { type: 'river-prism', enabled: true, collisionGroups: 0x0002ffff } };
    const lake: WaterBodySource = { ...common, type: 'lake', baseHeightM: .04, overlapPriority: 2, ...waterMaterialFamilySlots(family, 'lake'),
      spline: { closed: true, interpolationVersion: 'ue-water-spline/1', points: [point(0, -25, -19), point(1, 8, -24), point(2, 25, -8), point(3, 20, 17), point(4, -15, 22), point(5, -29, 8)] },
      collision: { type: 'polygon', enabled: true, channelDepthM: 10, collisionHeightOffsetM: 2, collisionGroups: 0x0002ffff } };
    const ocean: WaterBodySource = { ...common, type: 'ocean', overlapPriority: 0, ...waterMaterialFamilySlots(family, 'ocean'), oceanExtentM: [240, 200], centerOnWaterZone: false,
      spline: { closed: true, interpolationVersion: 'ue-water-spline/1', points: [point(0, -115, -95), point(1, 25, -95), point(2, 25, -32), point(3, 20, -19), point(4, 24, 18), point(5, 30, 32), point(6, 30, 95), point(7, -115, 95)] },
      collision: { type: 'polygon', enabled: true, collisionHalfHeightM: 12, collisionHeightOffsetM: 2, collisionHalfExtentsM: [120, 100], collisionGroups: 0x0002ffff } };
    const custom: WaterBodySource = { ...common, type: 'custom', ...waterMaterialFamilySlots(family, 'custom'),
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false }, renderOptions: { visible: false, castShadow: false, receiveShadow: false },
      spline: { closed: false, interpolationVersion: 'ue-water-spline/1', points: [point(0, 0, 0, .7, 5), point(1, 8, 0, 1.8, 5)] },
      collision: { type: 'polygon', enabled: true, points: [[-3, -4], [12, -4], [12, 4], [-3, 4]], collisionGroups: 0x0002ffff } };
    const probes = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`body/probe-${index}`, { ...lake, overlapPriority: index,
      flags: { affectsWaterInfo: false, affectsWaterMesh: true, affectsLandscape: false }, collision: { ...lake.collision, enabled: false } }]));
    const water = await buildWaterPackOutputs({ 'zone/estuary': { kind: 'water-zone', extentM: { spanXM: 192, spanZM: 160 }, tileSizeM: 3, tessellationFactor: 4, lodScale: 2,
      gpuMesh: { supersampling: 2, msaaSamples: 4, occlusion: 'disabled' },
      waterInfo: { resolution: { widthPx: 256, heightPx: 256 }, format: 'rgba16f', blurRadius: 1, localTessellation: false } }, 'body/river': river, 'body/lake': lake, 'body/ocean': ocean, 'body/custom': custom, ...probes },
    { packageId, readByGuid: async requested => AssetGuid.format(requested).toLowerCase() === guid('waves/estuary').toLowerCase() ? ok(waves) : readByGuid(requested) });
    if (!water.ok) return water;
    const terrainMaterials = { 'material/silt': material([.31, .38, .34, 1], .95), 'material/grass': material([.1, .23, .12, 1], .94) };
    const columns = 106, rows = 91, spacing = 2, heights = new Float32Array(columns * rows), weights = new Float32Array(columns * rows * 2);
    const fillTerrainSamples = () => {
      for (let z = 0; z < rows; z++)
        for (let x = 0; x < columns; x++) {
          const wx = -96 + x * spacing,
            wz = -80 + z * spacing;
          const riverZ =
            wx < -63
              ? -15 + (wx + 63) * 0.25
              : wx < -37
                ? -4 + ((wx + 37) * 11) / 26
                : ((wx + 15) * 4) / 22;
          const riverBank = (Math.abs(wz - riverZ) - 6.5) / 4;
          const lakeBank = (Math.sqrt(((wx + 2) / 27) ** 2 + (wz / 24) ** 2) - 1) * 5;
          const coast = (25 + 2 * Math.sin(wz * 0.1) - wx) / 7;
          const shore = Math.max(0, Math.min(1, Math.min(wx < -15 ? riverBank : 10, lakeBank, coast)));
          const hill = 1.8 + 2 * Math.sin(wx * 0.05) ** 2 * Math.cos(wz * 0.045) ** 2;
          const y = -4.5 + shore * shore * (3 - 2 * shore) * (4.5 + hill),
            i = z * columns + x;
          heights[i] = y;
          const grass = Math.max(0, Math.min(1, (y - 0.2) / 1.6));
          weights[i * 2] = 1 - grass;
          weights[i * 2 + 1] = grass;
        }
    };
    fillTerrainSamples();
    const terrain = buildTerrainAssets({ columns, rows, spacing, subsectionVertices: 16, heights, weights, layers: Object.keys(terrainMaterials).map(key => ({ material: guid(key), blend: 'weight' as const })) },
      key => guid(`terrain/estuary/${key}`), Object.fromEntries(Object.entries(terrainMaterials).map(([key, value]) => [guid(key), value])));
    if (!terrain.ok) return terrain;
    const entities: Record<string, SceneEntity> = {};
    const mesh = (key: string, shape: string, color: string, pos: readonly number[], scale: readonly number[], parent?: string) => {
      entities[key] = { components: { Transform: { pos, scale }, MeshFilter: { assetHandle: guid(`mesh/${shape}`) }, MeshRenderer: { materials: [guid(`material/${color}`)] },
        ...(parent ? { ChildOf: { parent } } : {}) } };
    };
    for (const type of CRAFTS) {
      const anchors = pontoonLayout(type === 'river' ? 4 : 16), key = `${type}-craft`, color = type === 'river' ? 'red' : type === 'lake' ? 'white' : 'ochre';
      entities[key] = { components: { Name: { value: key }, Transform: { pos: START_POSITIONS[type] },
        RigidBody: { type: 1, mass: 170, linearDamping: .025, angularDamping: .04, ccdEnabled: true },
        Collider: { shape: 5, mesh: guid('mesh/collider'), density: 1, collisionGroups: 0x0001ffff },
        WaterPontoonSet: { configurationVersion: 1, useAsyncPath: true, anchorMode: type === 'ocean' ? 1 : 0,
          anchorsM: type === 'ocean' ? anchors.flatMap(() => [0, 0, 0]) : anchors.flatMap(p => [...p]), radiiM: anchors.map(() => .8),
          socketEntities: type === 'ocean' ? anchors.map((_, i) => `${key}-socket-${i}`) : [], buoyancyCoefficientNPerM3: 1200, overlapFilterMask: 0xffff0002 } } };
      mesh(`${key}-hull`, 'hull', color, [0, .35, 0], [1, 1, 1], key);
      mesh(`${key}-deck`, 'box', 'white', [-.2, .7, 0], [3.4, .14, 1.6], key);
      mesh(`${key}-cabin`, 'box', color, [-.65, 1.12, 0], [1.3, .72, 1.08], key);
      mesh(`${key}-window`, 'box', 'glass', [-.65, 1.18, -.55], [.95, .32, .03], key);
      mesh(`${key}-roof`, 'box', 'white', [-.65, 1.52, 0], [1.48, .12, 1.2], key);
      mesh(`${key}-mast`, 'box', 'metal', [-1.4, 1.9, 0], [.045, 1.3, .045], key);
      mesh(`${key}-flag`, 'box', color, [-1.1, 2.4, 0], [.6, .25, .04], key);
      for (let i = 0; i < anchors.length; i++) {
        if (type === 'ocean') entities[`${key}-socket-${i}`] = { components: { Transform: { pos: anchors[i] }, ChildOf: { parent: key } } };
      }
      entities[type] = { components: { Name: { value: type }, Transform: {}, WaterBodyInstance: { body: guid(`body/${type}`) } } };
    }
    entities.zone = { components: { Transform: {}, WaterZoneInstance: { zone: zoneGuid } } };
    entities.custom = { components: { Transform: { pos: [70, 0, -50] }, WaterBodyInstance: { body: guid('body/custom') } } };
    entities.terrain = { components: { Transform: { pos: [-96, 0, -80] }, Terrain: { asset: guid('terrain/estuary/terrain') }, RigidBody: { type: 0 }, WaterTerrainProvider: { terrain: guid('terrain/estuary/terrain') } } };
    mesh('pier', 'box', 'concrete', [-4, .65, 19], [31, .35, 2.5]);
    for (let i = 0; i < 17; i++) mesh(`pier-joint-${i}`, 'box', 'metal', [-18 + i * 1.8, .84, 19], [.035, .025, 2.45]);
    for (const x of [-17, -9, 0, 9]) for (const z of [18.1, 19.9]) mesh(`pier-leg-${x}-${z}`, 'box', 'concrete', [x, -1, z], [.3, 3.5, .3]);
    mesh('breakwater', 'box', 'concrete', [49, 1.5, 22], [36, 3, 2.8]);
    for (let i = 0; i < 5; i++) mesh(`breakwater-mark-${i}`, 'box', 'ochre', [34 + i * 7.5, 3.1, 22], [.35, .2, 2.7]);
    for (const [i, x, z] of [[0, -63, -5], [1, -22, 25], [2, 33, 25]] as const) {
      mesh(`beacon-${i}`, 'box', 'white', [x, 3, z], [1.3, 5.8, 1.3]);
      mesh(`beacon-light-${i}`, 'sphere', i === 2 ? 'ochre' : 'red', [x, 6.1, z], [.8, .5, .8]);
    }
    return ok({ ...water.value, ...terrainMaterials, ...Object.fromEntries(Object.entries(terrain.value).map(([key, value]) => [`terrain/estuary/${key}`, value])),
      'scene/estuary': { kind: 'scene', entities } satisfies SceneAsset,
      'waves/estuary': waves, 'waves/off': off, 'mesh/hull': hull(), 'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/sphere': createSphereGeometry(1, 20, 12).unwrap(), 'mesh/collider': createBoxGeometry(4, .65, 1.7).unwrap(),
      'material/white': material([.84, .91, .9, 1], .35), 'material/red': material([.7, .055, .04, 1], .3),
      'material/ochre': material([.94, .57, .065, 1], .32), 'material/glass': material([.025, .07, .08, 1], .12, .6),
      'material/metal': material([.12, .18, .19, 1], .3, .65), 'material/concrete': material([.38, .44, .42, 1], .9) });
  },
});
