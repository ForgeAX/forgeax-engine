import { definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok, type MaterialAsset } from '@forgeax/engine/types';
import { buildWaterPackOutputs } from '@forgeax/engine/water';
import {
  SURFACE_EVIDENCE_PACKAGE_NAMESPACE,
  surfaceEvidenceGuid,
  waterR0RecipeGuid,
} from '../src/surface-standard-evidence-identity';
import {
  SURFACE_OPTICAL_BACKGROUND_SOURCE_KEY,
  SURFACE_OPTICAL_CASES,
  type SurfaceOpticalParameters,
} from '../src/surface-optical-evidence';

const packageId = SURFACE_EVIDENCE_PACKAGE_NAMESPACE;

const defaultPhysical: MaterialAsset = Materials.standard({
  staticSwitches: { clearcoat: true },
  baseColor: [0.28, 0.035, 0.075, 1],
  metallic: 0.12,
  roughness: 0.18,
  clearcoat: 0.82,
  clearcoatRoughness: 0.08,
});
const customPhysical: MaterialAsset = Materials.standard({
  staticSwitches: { clearcoat: true },
  surfaceModule: 'game_3d::rusted_iron_surface',
  parameters: [
    { name: 'ironColor', type: 'color' },
    { name: 'rustDark', type: 'color' },
    { name: 'rustBright', type: 'color' },
    { name: 'noiseScale', type: 'f32' },
    { name: 'clearcoat', type: 'f32' },
    { name: 'clearcoatRoughness', type: 'f32' },
  ],
  values: {
    ironColor: [0.07, 0.08, 0.09, 1],
    rustDark: [0.02, 0.003, 0.001, 1],
    rustBright: [0.18, 0.025, 0.004, 1],
    noiseScale: 1.85,
    clearcoat: 0.05,
    clearcoatRoughness: 0.35,
  },
});
const mediumParameters = [
  { name: 'roughness', type: 'f32' },
  { name: 'coverage', type: 'f32' },
  { name: 'foamBase', type: 'f32' },
  { name: 'foamScale', type: 'f32' },
  { name: 'absorption', type: 'vec3' },
  { name: 'scattering', type: 'vec3' },
  { name: 'ior', type: 'f32' },
  { name: 'phaseG', type: 'f32' },
  { name: 'maxDistanceMeters', type: 'f32' },
  { name: 'waveAmplitude', type: 'vec2' },
] as const;

const waterAParameters: SurfaceOpticalParameters = {
  roughness: 0.16,
  coverage: 1,
  foamBase: 0,
  foamScale: 0.18,
  absorption: [0.22, 0.07, 0.025],
  scattering: [0.018, 0.04, 0.085],
  ior: 1.333,
  phaseG: 0.24,
  maxDistanceMeters: 900,
  waveAmplitude: [0.08, 0.05],
};

const waterBParameters: SurfaceOpticalParameters = {
  roughness: 0.34,
  coverage: 1,
  foamBase: 0.12,
  foamScale: 0.42,
  absorption: [0.055, 0.018, 0.008],
  scattering: [0.075, 0.045, 0.018],
  ior: 1.338,
  phaseG: -0.08,
  maxDistanceMeters: 650,
  waveAmplitude: [0.17, 0.13],
};

const mediumSurface = (module: string, values: SurfaceOpticalParameters): MaterialAsset => ({
  kind: 'material',
  surface: {
    model: 'single-layer-medium',
    module,
    dynamicInput: {
      name: 'waterEvents',
      fields: [
        { name: 'position', type: 'vec3<f32>' },
        { name: 'time', type: 'f32' },
        { name: 'eventId', type: 'u32' },
      ],
      maxRecords: 64,
      maxDomains: 2,
      maxPageBytes: 2048,
      maxBindings: 1,
      maxEventsPerSample: 8,
    },
  },
  passes: [{ name: 'color', program: { module: 'forgeax::single-layer-medium' } }],
  parameters: mediumParameters,
  values,
});

const opticalBackground: MaterialAsset = Materials.standard({
  baseColor: [0, 0, 0, 1],
  metallic: 0,
  roughness: 1,
  emissive: [0.55, 0.38, 0.22],
  emissiveIntensity: 1,
});

const waterDemoZoneGuid = surfaceEvidenceGuid('water/zone/r0-demo');
const waterDemoMaterialGuid = surfaceEvidenceGuid('material/water-surface-a');
const waterDemoWaveSetGuid = (kind: 'calm' | 'windy') => waterR0RecipeGuid(`water/wave-set/${kind}`);
const waterBodySourceKey = (type: 'river' | 'lake' | 'ocean' | 'custom') => type === 'river' ? 'river/main' : `water/body/${type}`;
const waterSplinePoint = (inputKey: number, positionM: readonly [number, number, number]) => ({
  inputKey, positionM, arriveTangentM: [1, 0, 0] as const, leaveTangentM: [1, 0, 0] as const,
  up: [0, 1, 0] as const, rollAngle: 0, angleUnit: 'degrees' as const, widthM: 8,
  depthM: 1, velocityMPerSec: 0.75, audioIntensity: 0,
});
const waterBody = (type: 'river' | 'lake' | 'ocean' | 'custom') => ({
  kind: 'water-body' as const,
  type,
  spline: {
    closed: type === 'lake' || type === 'ocean',
    points: type === 'river'
      ? [waterSplinePoint(0, [0, 0, 0]), waterSplinePoint(1, [8, 0, 0])]
      : type === 'lake'
        ? [waterSplinePoint(0, [-2, 0, -2]), waterSplinePoint(1, [2, 0, -2]), waterSplinePoint(2, [2, 0, 2]), waterSplinePoint(3, [-2, 0, 2])]
        : type === 'ocean'
          ? [waterSplinePoint(0, [-3, 0, -2]), waterSplinePoint(1, [3, 0, -2]), waterSplinePoint(2, [3, 0, 2]), waterSplinePoint(3, [-3, 0, 2])]
          : [waterSplinePoint(0, [-1.5, 0, 0]), waterSplinePoint(1, [1.5, 0, 0])],
  },
  baseHeightM: 0, overlapPriority: type === 'ocean' ? -1 : 0, maxWaveHeightM: type === 'ocean' ? 1.1 : 0.4,
  surfaceMaterialGuid: waterDemoMaterialGuid, zoneGuid: waterDemoZoneGuid,
  ...(type === 'ocean' ? { oceanExtentM: [80, 60] as const, centerOnWaterZone: true, savedZoneLocationWorldXZ: [0, 0] as const } : {}),
  ...(type === 'lake' ? { waveSetGuid: waterDemoWaveSetGuid('calm') } : type === 'ocean' ? { waveSetGuid: waterDemoWaveSetGuid('windy') } : {}),
  flags: type === 'custom'
    ? { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false }
    : { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: type === 'river'
    ? { type: 'river-prism' as const, enabled: true }
    : type === 'lake'
      ? { type: 'polygon' as const, enabled: true, channelDepthM: 1 }
      : { type: 'none' as const, enabled: false },
  queryFootprint: type === 'river'
    ? [[0, -4], [8, -4], [8, 4], [0, 4]]
    : type === 'lake'
      ? [[-2, -2], [2, -2], [2, 2], [-2, 2]]
      : type === 'ocean'
        ? [[-3, -2], [3, -2], [3, 2], [-3, 2]]
        : [[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]],
});

export const SURFACE_EVIDENCE_CUSTOM_PHYSICAL_GUID = surfaceEvidenceGuid(
  'material/rusted-iron-custom-physical',
);
export const SURFACE_EVIDENCE_DEFAULT_PHYSICAL_GUID = surfaceEvidenceGuid(
  'material/painted-evidence',
);
export const SURFACE_EVIDENCE_CUSTOM_PHYSICAL_SOURCE_KEY =
  'preview-surface-standard-evidence:material/rusted-iron-custom-physical';

const opticalMaterials = Object.fromEntries(
  SURFACE_OPTICAL_CASES.map((surfaceCase) => [
    surfaceCase.sourceKey.replace('preview-surface-standard-evidence:', ''),
    mediumSurface('preview::water_surface_a', surfaceCase.parameters),
  ]),
);

const {
  'material/water-optical-zero-extinction': planarWater,
  ...otherOpticalMaterials
} = opticalMaterials;
if (planarWater === undefined) throw new Error('Missing the zero-extinction optical material');

export const planarReflectionMaterials = {
  'material/planar-red': Materials.unlit([1, 0, 0, 1]),
  'material/planar-green': Materials.unlit([0, 1, 0, 1]),
  'material/water-optical-zero-extinction': planarWater,
} as const;

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Preview Surface Evidence',
  build: async ({ packageId, readByGuid }) => {
    const waterOutputs = await buildWaterPackOutputs({
      'water/zone/r0-demo': {
        kind: 'water-zone', extentM: { spanXM: 160, spanZM: 120 }, tileSizeM: 2,
        tessellationFactor: 4, lodScale: 1,
        waterInfo: { resolution: { widthPx: 256, heightPx: 256 }, format: 'rgba16f', blurRadius: 1, localTessellation: true },
      },
      'river/main': waterBody('river'),
      'water/body/lake': waterBody('lake'),
      'water/body/ocean': waterBody('ocean'),
      'water/body/custom': waterBody('custom'),
    }, { packageId, readByGuid, bodyWorldTransformsM: {
      'water/body/lake': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0.12, 1, 1],
      'water/body/ocean': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 0.12, 1, 1],
    } });
    if (!waterOutputs.ok) return waterOutputs;
    return ok({
      ...planarReflectionMaterials,
      // A cooked glass: its program declares the dedicated transmission backdrop.
      'material/cooked-glass': Materials.standard({
        baseColor: [0.9, 0.95, 1, 1],
        roughness: 0.05,
        transmission: 0.9,
        ior: 1.5,
      }),
      'material/planar-mirror': Materials.standard({
        baseColor: [0.9, 0.9, 0.9, 1],
        metallic: 1,
        roughness: 0.05,
        planarReflection: true,
      }),
      'material/planar-rough-mirror': Materials.standard({
        baseColor: [0.9, 0.9, 0.9, 1],
        metallic: 1,
        roughness: 0.8,
        planarReflection: true,
      }),
      'material/painted-evidence': defaultPhysical,
      'material/rusted-iron-custom-physical': customPhysical,
      'material/shore-sand': Materials.standard({
        surfaceModule: 'preview::shore_sand',
        parameters: [{ name: 'sandColor', type: 'color' }],
        values: { sandColor: [0.62, 0.47, 0.28, 1] },
      }),
      'material/shore-rock': Materials.standard({
        baseColor: [0.2, 0.24, 0.22, 1],
        roughness: 0.65,
      }),
      'material/shore-wood': Materials.standard({
        baseColor: [0.16, 0.075, 0.032, 1],
        roughness: 0.8,
      }),
      'material/shore-foliage': Materials.standard({
        baseColor: [0.055, 0.14, 0.065, 1],
        roughness: 0.85,
      }),
      'material/water-shore': mediumSurface('preview::water_shore', {
        ...waterAParameters,
        roughness: 0.1,
        absorption: [0.32, 0.075, 0.035],
        scattering: [0.012, 0.055, 0.045],
        waveAmplitude: [0.075, 0.055],
        maxDistanceMeters: 30,
      }),
      'material/water-surface-a': mediumSurface('preview::water_surface_a', waterAParameters),
      'material/water-surface-b': mediumSurface('preview::water_surface_b', waterBParameters),
      [SURFACE_OPTICAL_BACKGROUND_SOURCE_KEY.replace('preview-surface-standard-evidence:', '')]:
        opticalBackground,
      ...otherOpticalMaterials,
      ...waterOutputs.value,
    });
  },
});
