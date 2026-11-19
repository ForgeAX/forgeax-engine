import { EngineContent } from '@forgeax/engine/content';
import { createIcosahedronGeometry, createMeshBuilder } from '@forgeax/engine/geometry';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import { ok, type TerrainSource } from '@forgeax/engine/types';
import {
  buildWaterMaterialFamily,
  buildWaterPackOutputs,
  cookWaterAsset,
  waterMaterialFamilySlots,
} from '@forgeax/engine/water';
import { demoWaveSetSource } from '../../demo-wave-set';
import { environment, surfaceTexture } from '../../r8-integration-acceptance/assets/procedural';
import { WATER_MESH_DEMO_PACKAGE } from '../src/identity';
import {
  islandOutline,
  LAKE_CENTER,
  lakeOutline,
  RIVER_PATH,
  WORLD_COLUMNS,
  WORLD_ORIGIN,
  WORLD_SPACING_M,
  watershedHeight,
  watershedVariantOffset,
} from '../src/watershed';

const point = (
  i: number,
  x: number,
  y: number,
  z: number,
  velocityMPerSec: number,
  width = 12,
) => ({
  inputKey: i,
  positionM: [x, y, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  rotationQuat: [0, 0, 0, 1] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: width,
  depthM: 3,
  velocityMPerSec,
  audioIntensity: 0,
});
function weatheredRock(variant: number) {
  const sphere = createIcosahedronGeometry(1, 1).unwrap();
  const original = sphere.attributes.position;
  if (!(original instanceof Float32Array) || sphere.indices === undefined)
    throw new Error('Rock position source missing');
  const position = Float32Array.from(original);
  for (let vertex = 0; vertex < position.length; vertex += 3) {
    const x = original[vertex] ?? 0,
      y = original[vertex + 1] ?? 0,
      z = original[vertex + 2] ?? 0;
    const erosion =
      0.82 + Math.sin(x * 4.1 + z * 3.7 + variant) * 0.12 + Math.cos(y * 5.3 - x * 2.9) * 0.06;
    position[vertex] = x * erosion + y * 0.11;
    position[vertex + 1] = y * erosion * 0.7;
    position[vertex + 2] = z * erosion * (0.86 + variant * 0.08);
  }
  return createMeshBuilder({ attributes: { position }, indices: sphere.indices }).build().unwrap();
}

function terrainHeightSampler() {
  const rows = new Map<number, Map<number, number>>();
  return (x: number, z: number, variant: number) => {
    let row = rows.get(z);
    if (row === undefined) {
      row = new Map();
      rows.set(z, row);
    }
    let base = row.get(x);
    if (base === undefined) {
      base = watershedHeight(x, z);
      row.set(x, base);
    }
    return base + watershedVariantOffset(x, z, variant);
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_MESH_DEMO_PACKAGE,
  name: 'Island Watershed R0–R2',
  build: async ({ packageId, readByGuid }) => {
    const g = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const textures = {
      'texture/sand': surfaceTexture('sand'),
      'texture/rock': surfaceTexture('rock'),
    };
    const terrainMaterials = {
      'material/sand': Materials.standard({
        baseColor: [0.66, 0.59, 0.43, 1],
        roughness: 0.9,
        baseColorTexture: g('texture/sand'),
      }),
      'material/grass': Materials.standard({
        baseColor: [0.22, 0.3, 0.13, 1],
        roughness: 0.92,
        baseColorTexture: g('texture/rock'),
      }),
      'material/rock': Materials.standard({
        baseColor: [0.43, 0.45, 0.39, 1],
        roughness: 0.87,
        baseColorTexture: g('texture/rock'),
      }),
    };
    const terrainOutputs: Record<string, unknown> = {};
    // Both variants share the exact same shoreline and slope sample positions.
    // Numeric keys preserve the original wx + spacing arithmetic; rounding to
    // a grid index would silently change some floating-point sample positions.
    const heightAt = terrainHeightSampler();
    for (const variant of ['a', 'b'] as const) {
      const heights = new Float32Array(WORLD_COLUMNS ** 2),
        weights = new Float32Array(heights.length * 3);
      for (let z = 0; z < WORLD_COLUMNS; z++)
        for (let x = 0; x < WORLD_COLUMNS; x++) {
          const h = heightAt(
            WORLD_ORIGIN[0] + x * WORLD_SPACING_M,
            WORLD_ORIGIN[2] + z * WORLD_SPACING_M,
            variant === 'b' ? 1 : 0,
          );
          const i = z * WORLD_COLUMNS + x;
          heights[i] = h;
          const wx = WORLD_ORIGIN[0] + x * WORLD_SPACING_M,
            wz = WORLD_ORIGIN[2] + z * WORLD_SPACING_M;
          const slope =
            Math.hypot(
              heightAt(wx + WORLD_SPACING_M, wz, variant === 'b' ? 1 : 0) - h,
              heightAt(wx, wz + WORLD_SPACING_M, variant === 'b' ? 1 : 0) - h,
            ) / WORLD_SPACING_M;
          const patch =
            0.5 +
            0.25 * Math.sin(wx * 0.061 + Math.sin(wz * 0.039) * 2.1) +
            0.25 * Math.cos(wz * 0.075 - wx * 0.023);
          const rock = Math.max(0, Math.min(0.78, (slope - 0.42) * 0.65 + (h - 32) / 40));
          const grass =
            Math.max(0, Math.min(1, (h - 1.5) / 8)) * (1 - rock) * (0.72 + patch * 0.28);
          weights.set([1 - rock - grass, grass, rock], i * 3);
        }
      const source: TerrainSource = {
        columns: WORLD_COLUMNS,
        rows: WORLD_COLUMNS,
        spacing: WORLD_SPACING_M,
        subsectionVertices: 64,
        heights,
        weights,
        layers: [
          { material: g('material/sand'), blend: 'weight' },
          { material: g('material/grass'), blend: 'weight' },
          { material: g('material/rock'), blend: 'weight' },
        ],
      };
      const closure = Object.fromEntries(
        Object.entries({ ...textures, ...terrainMaterials }).map(([k, v]) => [g(k), v]),
      );
      const result = buildTerrainAssets(source, (key) => g(`terrain/${variant}/${key}`), closure);
      if (!result.ok) return result;
      for (const [k, v] of Object.entries(result.value))
        terrainOutputs[`terrain/${variant}/${k}`] = v;
    }
    const waves = cookWaterAsset(demoWaveSetSource()).unwrap();
    const calm = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [
          { directionXZ: [1, 0], wavelengthM: 14, amplitudeM: 0.12, steepness: 0.025 },
          { directionXZ: [0.3, 0.95], wavelengthM: 7, amplitudeM: 0.05, steepness: 0.02 },
        ],
      },
      depthMaskM: 3,
      maxWaveHeightM: 0.3,
      timeSource: 'scene-clock',
    }).unwrap();
    // Smooth centreline derivatives and the broad estuary belong to the same authored geometry closure.
    const waterTextures = Object.fromEntries(
      [
        ['waterNormalTexture', 'normal'],
        ['waterFlowTexture', 'river-diffuse'],
        ['waterFlowNormalTexture', 'river-normal'],
        ['waterFoamTexture', 'foam'],
        ['waterFoamNormalTexture', 'foam-normal'],
        ['waterNoiseTexture', 'noise'],
        ['waterVolumeNoiseTexture', 'volume-noise'],
      ].map(([parameter, texture]) => [
        parameter,
        {
          texture:
            EngineContent.water.textures[texture as keyof typeof EngineContent.water.textures],
          sampler: EngineContent.water.sampler,
        },
      ]),
    );
    // One scene optical and detail-normal authority; generic branch switches stay family-owned.
    const family = buildWaterMaterialFamily(packageId, 'material/watershed', {
      ...waterTextures,
      absorptionPerM: [0.18, 0.04, 0.02],
      scatteringPerM: [0.025, 0.045, 0.05],
      roughness: 0.075,
      fresnelRoughness: 0.11,
      normalStrength: 0.18,
      distantNormalStrength: 0.18,
      normalTilingM: 8,
      distantNormalTilingM: 28,
      normalFarStartM: 65,
      normalFarRangeM: 180,
      normalSpeed: 0.42,
    });
    const lakeRing = lakeOutline().map(([x, z], i) => point(i, x, LAKE_CENTER[1], z, 0));
    const oceanRing = islandOutline().map(([x, z], i) => point(i, x, 0, z, 0));
    const base = (type: 'river' | 'lake' | 'ocean') => ({
      kind: 'water-body' as const,
      type,
      zoneGuid: g('zone/main'),
      waveSetGuid: g(type === 'lake' ? 'waves/calm' : 'waves/seed-731-v1'),
      ...waterMaterialFamilySlots(family, type),
      maxWaveHeightM: type === 'lake' ? 0.4 : 3,
      baseHeightM: type === 'lake' ? LAKE_CENTER[1] : 0,
      overlapPriority: type === 'river' ? 5 : type === 'lake' ? 4 : 1,
      queryFootprint:
        type === 'lake'
          ? [
              [-244, -117],
              [-136, -117],
              [-136, -33],
              [-244, -33],
            ]
          : type === 'river'
            ? [
                [-170, -213],
                [171, -213],
                [171, -67],
                [-170, -67],
              ]
            : [
                [-5000, -5000],
                [5000, -5000],
                [5000, 5000],
                [-5000, 5000],
              ],
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      collision: {
        type: type === 'river' ? ('river-prism' as const) : ('polygon' as const),
        enabled: true,
        ...(type === 'ocean'
          ? { collisionHalfHeightM: 50, collisionHalfExtentsM: [5000, 5000] as const }
          : type === 'lake'
            ? { channelDepthM: 3.5 }
            : {}),
      },
      surfaceMaterialGuid: g(`material/${type}`),
      lodMaterialGuid: g(`material/${type}-lod`),
    });
    const custom = createMeshBuilder({
      attributes: {
        position: new Float32Array([-5, 0, -5, 5, 0, -5, -5, 0, 5, 5, 0, 5]),
        uv: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      },
      indices: [0, 2, 1, 1, 2, 3],
    })
      .build()
      .unwrap();
    const sources = {
      'zone/main': {
        kind: 'water-zone' as const,
        extentM: { spanXM: 1024, spanZM: 1024 },
        tileSizeM: 16,
        tessellationFactor: 5,
        lodScale: 2,
        waterInfo: {
          resolution: { widthPx: 512, heightPx: 512 },
          format: 'rgba16f' as const,
          blurRadius: 2,
          localTessellation: false,
        },
        farExtentM: { spanXM: 12000, spanZM: 12000 },
        farMaterialGuid: g('material/far'),
      },
      'body/ocean': {
        ...base('ocean'),
        oceanExtentM: [10000, 10000],
        centerOnWaterZone: false,
        spline: { closed: true, interpolationVersion: 'water-spline/2', points: oceanRing },
      },
      'body/lake': {
        ...base('lake'),
        spline: { closed: true, interpolationVersion: 'water-spline/2', points: lakeRing },
      },
      'body/river': {
        ...base('river'),
        spline: {
          closed: false,
          interpolationVersion: 'water-spline/2',
          points: RIVER_PATH.map((p, i) => {
            const before = RIVER_PATH[Math.max(0, i - 1)] ?? p;
            const after = RIVER_PATH[Math.min(RIVER_PATH.length - 1, i + 1)] ?? p;
            const divisor = i === 0 || i === RIVER_PATH.length - 1 ? 1 : 2;
            const tangent = [
              (after[0] - before[0]) / divisor,
              (after[1] - before[1]) / divisor,
              (after[2] - before[2]) / divisor,
            ] as const;
            return {
              ...point(i, p[0], p[1], p[2], 2.8, p[3]),
              interpolationMode: 'curve-custom-tangent' as const,
              arriveRotationQuat: [0, 0, 0, 1] as const,
              leaveRotationQuat: [0, 0, 0, 1] as const,
              arriveTangentM: tangent,
              leaveTangentM: tangent,
            };
          }),
        },
        riverToLakeTransitionMaterialGuid: g('material/transition-lake'),
        riverToOceanTransitionMaterialGuid: g('material/transition-ocean'),
        // The shared estuary edge reaches 129 m upstream; include its paired grid triangles.
        transitionContinuity: { target: 'ocean', endpoint: 'end', reachM: 144, blendWidthM: 12 },
      },
      'body/custom': {
        kind: 'water-body',
        type: 'custom',
        zoneGuid: g('zone/main'),
        spline: {
          closed: false,
          interpolationVersion: 'water-spline/2',
          points: [point(0, -5, 0, 0, 2.8), point(1, 5, 0, 0, 2.8)],
        },
        queryFootprint: [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
        baseHeightM: 0,
        maxWaveHeightM: 0,
        overlapPriority: 0,
        surfaceMaterialGuid: g('material/custom'),
        customMeshOverrideGuid: g('mesh/custom'),
        flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
        collision: { type: 'none', enabled: false },
      },
    };
    const built = await buildWaterPackOutputs(sources, {
      packageId,
      readByGuid: async (guid) => {
        const id = AssetGuid.format(guid);
        if (id === g('waves/seed-731-v1')) return ok(waves);
        if (id === g('waves/calm')) return ok(calm);
        if (id === g('mesh/custom')) return ok(custom);
        return readByGuid(guid);
      },
    });
    if (!built.ok) return built;
    const waterMaterials = Object.fromEntries(
      ['river', 'lake', 'ocean'].flatMap((type) => {
        const optics =
          type === 'lake'
            ? {
                roughness: 0.065,
                absorptionPerM: [0.07, 0.035, 0.015],
                scatteringPerM: [0.025, 0.045, 0.05],
              }
            : type === 'river'
              ? { roughness: 0.12 }
              : {};
        return [
          [
            `material/${type}`,
            {
              kind: 'material',
              parent: family.guids[type as keyof typeof family.guids],
              values: optics,
            },
          ],
          [
            `material/${type}-lod`,
            {
              kind: 'material',
              parent: family.guids[`${type}-lod` as keyof typeof family.guids],
              values: optics,
            },
          ],
        ];
      }),
    );
    return ok({
      ...built.value,
      ...terrainOutputs,
      ...textures,
      ...terrainMaterials,
      ...waterMaterials,
      ...family.outputs,
      ...Object.fromEntries(
        [0, 1, 2].map((variant) => [`mesh/scenery-rock-${variant}`, weatheredRock(variant)]),
      ),
      ...Object.fromEntries(
        [0, 1, 2].map((variant) => [
          `material/scenery-leaf-${variant}`,
          Materials.standard({
            baseColor:
              variant === 0
                ? [0.095, 0.25, 0.105, 1]
                : variant === 1
                  ? [0.16, 0.3, 0.11, 1]
                  : [0.075, 0.2, 0.115, 1],
            roughness: 0.86,
            renderState: { cullMode: 'none' },
          }),
        ]),
      ),
      ...Object.fromEntries(
        [0, 1].map((variant) => [
          `material/scenery-rock-${variant}`,
          Materials.standard({
            baseColor: variant ? [0.39, 0.4, 0.33, 1] : [0.5, 0.47, 0.38, 1],
            roughness: 0.94,
            baseColorTexture: g('texture/rock'),
          }),
        ]),
      ),
      'material/far': { kind: 'material', parent: family.guids.far },
      'material/transition-lake': {
        kind: 'material',
        parent: family.guids['river-to-lake'],
        values: { roughness: 0.12 },
      },
      'material/transition-ocean': {
        kind: 'material',
        parent: family.guids['river-to-ocean'],
        // The estuary shares Ocean optics; River flow detail belongs to the upstream branch.
        staticSwitches: { waterFlowmap: false },
        values: { roughness: 0.075 },
      },
      'material/custom': {
        kind: 'material',
        parent: family.guids.custom,
        values: { roughness: 0.12 },
      },
      'mesh/custom': custom,
      'waves/seed-731-v1': waves,
      'waves/calm': calm,
      'sky/world': environment('day', false, 1024),
    });
  },
});
