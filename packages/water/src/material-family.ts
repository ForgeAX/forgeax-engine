import { AssetGuid, type PackageId } from '@forgeax/engine-pack/source';
import {
  type MaterialAsset,
  type MaterialParameter,
  type MaterialStaticSwitches,
  type MaterialValue,
  WATER_DEFORMATION_INPUTS,
  WATER_DEFORMATION_VERSION,
} from '@forgeax/engine-types';

export const WATER_MATERIAL_FAMILY_KEYS = [
  'root',
  'instance',
  'river',
  'lake',
  'ocean',
  'custom',
  'river-to-lake',
  'river-to-ocean',
  'river-lod',
  'lake-lod',
  'ocean-lod',
  'custom-lod',
  'far',
  'hlod',
  'water-info',
  'underwater',
  'custom-underwater',
] as const;
export type WaterMaterialFamilyKey = (typeof WATER_MATERIAL_FAMILY_KEYS)[number];
export interface WaterMaterialFamily {
  readonly guids: Readonly<Record<WaterMaterialFamilyKey, string>>;
  readonly outputs: Readonly<Record<string, MaterialAsset>>;
}

const numeric = (
  name: string,
  type: MaterialParameter['type'],
  value: MaterialValue,
): MaterialParameter => ({ name, type, default: value });
/** Author-time optical values are stored in inverse meters. */
export const WATER_SURFACE_PARAMETERS: readonly MaterialParameter[] = Object.freeze([
  numeric('absorptionPerM', 'vec3', [1.25, 1 / 12, 1 / 28]),
  numeric('scatteringPerM', 'vec3', [0.05, 0.05, 0.05]),
  numeric('foamScatteringPerM', 'vec3', [0.5, 0.5, 0.5]),
  numeric('coefficientMask', 'f32', 1),
  numeric('roughness', 'f32', 0.02),
  numeric('fresnelRoughness', 'f32', 0.1),
  numeric('specular', 'f32', 0.225),
  numeric('waterAlbedo', 'vec3', [0.85, 0.85, 0.85]),
  numeric('causticsMaxIntensity', 'f32', 1),
  numeric('criticalAngleDot', 'f32', 0.225),
  numeric('criticalAngleWidth', 'f32', 0.01),
  numeric('criticalAngleBendWidth', 'f32', -0.75),
  numeric('refractionBottomAmount', 'f32', 1),
  numeric('lipRefraction', 'f32', 0.95),
  numeric('opacityMaskDepthOffsetM', 'f32', 0.24),
  numeric('simulationWaterDepthM', 'f32', 0),
  numeric('fluidNormalStrength', 'f32', 1),
  numeric('fluidDisplacementMultiplier', 'f32', 1),
  numeric('maximumFluidDisplacementM', 'f32', 10.24),
  numeric('showFluidSimulation', 'f32', 1),
  numeric('phaseG', 'f32', 0.1),
  numeric('refractionPixelNormalStrength', 'f32', 1.15),
  numeric('distantRefractionPixelNormalStrength', 'f32', 1.02),
  numeric('refractionDistanceM', 'f32', 50),
  numeric('colorScaleBehindWater', 'vec3', [1, 1, 1]),
  numeric('maximumOpticalDistanceM', 'f32', 1000),
  numeric('maximumFlowVelocityMPerSec', 'f32', 10.24),
  numeric('waveVelocityMaskThresholdMPerSec', 'f32', 1),
  numeric('flowSpeed', 'f32', 1),
  numeric('flowMapTiling', 'f32', 1),
  numeric('flowmapDepthBiasM', 'f32', 0.64),
  numeric('flowmapDepthDensityPerM', 'f32', 0.3),
  numeric('flowmapDetectionVelocityMPerSec', 'f32', 0.64),
  numeric('flowmapSpeed', 'f32', 0.003),
  numeric('flowmapTimeModulationSizeM', 'f32', 27.5),
  numeric('flowmapFlip', 'vec4', [1, -1, 0, 0]),
  numeric('riverNormalTilingM', 'f32', 5.12),
  numeric('normalFlatness', 'f32', 0.5),
  numeric('normalTilingM', 'f32', 5.12),
  numeric('distantNormalTilingM', 'f32', 35),
  numeric('normalSpeed', 'f32', 0.75),
  numeric('normalStrength', 'f32', 0.25),
  numeric('distantNormalStrength', 'f32', 0.3),
  numeric('normalFarStartM', 'f32', 50),
  numeric('normalFarRangeM', 'f32', 100),
  numeric('foamTilingM', 'f32', 15.36),
  numeric('foamDepthMinimumM', 'f32', 0.64),
  numeric('foamContrast', 'f32', 1),
  numeric('foamAmount', 'f32', 1),
  numeric('foamRoughness', 'f32', 0.4),
  numeric('foamAttachment', 'f32', 0.4),
  numeric('foamNormalIntensity', 'f32', 0.5),
  numeric('foamNormalUvOffset', 'f32', 0.0019529999699443579),
  numeric('foamNormalZ', 'f32', 2),
  numeric('foamNormalMultiplier', 'vec3', [0.5, 0.5, 1]),
  numeric('foamEmissiveColor', 'vec3', [0.287440896, 1, 0.18782079]),
  numeric('foamPower', 'f32', 0.2),
  numeric('foamBoost', 'f32', 1),
  numeric('foamHeightBias', 'f32', -1),
  numeric('foamFrontScaleM', 'f32', 6.54),
  numeric('foamFrontHeightBias', 'f32', -0.5),
  numeric('foamScatteringMip', 'f32', 8),
  numeric('foamTextureBlendMinimum', 'f32', 0.4),
  numeric('foamTextureBlendWidth', 'f32', 0.4),
  numeric('foamScatterBias', 'f32', 0.25),
  numeric('foamEraseNearFluidSize', 'f32', 0.5),
  numeric('foamMaskNearFluid', 'f32', 1),
  numeric('foamFluidEraseScale', 'f32', 0.5),
  numeric('waveCaptureSizeM', 'f32', 100),
  numeric('fluidSimulationSizeM', 'f32', 20.48),
  numeric('simulationLocationM', 'vec3', [0, 0, 0]),
  numeric('simulationFoamContrast', 'f32', 0),
  numeric('oceanPatchDomainM', 'f32', 2.5),
  numeric('oceanPatchNormalStrength', 'f32', 1),
  numeric('oceanPatchAdvectionSpeed', 'f32', 1),
  numeric('WPOWaveScale', 'f32', 1),
  numeric('BakedWaterSimSize', 'f32', 256),
  numeric('oceanPatchPulseSeconds', 'f32', 1),
  numeric('oceanPatchBracketAngleDegrees', 'f32', 0),
  numeric('oceanPatchBracketSpeedMPerSec', 'f32', 0),
  numeric('refractionDepthBias', 'f32', 0),
  numeric('surfaceCrestFoamAmount', 'f32', 0),
  numeric('surfaceCrestFoamCompressionMinimum', 'f32', 0.12),
  numeric('surfaceCrestFoamCompressionRange', 'f32', 0.32),
  numeric('sceneDepthFoamAmount', 'f32', 0),
  numeric('sceneDepthFoamWidthM', 'f32', 1.2),
  numeric('contactFoamAmount', 'f32', 1),
  { name: 'waterNormalTexture', type: 'texture' },
  { name: 'waterFlowTexture', type: 'texture' },
  { name: 'waterFoamTexture', type: 'texture' },
  { name: 'waterFlowNormalTexture', type: 'texture' },
  { name: 'waterFoamNormalTexture', type: 'texture' },
  { name: 'waterNoiseTexture', type: 'texture' },
  { name: 'waterVolumeNoiseTexture', type: 'texture_3d' },
  { name: 'waterShallowGridTexture', type: 'texture', sampleType: 'unfilterable-float' },
  { name: 'waterShallowNormalTexture', type: 'texture', sampleType: 'unfilterable-float' },
  { name: 'waterShallowFoamTexture', type: 'texture', sampleType: 'unfilterable-float' },
  { name: 'waterShallowMappingTexture', type: 'texture', sampleType: 'unfilterable-float' },
  { name: 'waterOceanPatchTexture', type: 'texture', sampleType: 'unfilterable-float' },
  { name: 'NormalDetailTex', type: 'texture', sampleType: 'unfilterable-float' },
]);

export const WATER_UNDERWATER_PARAMETERS: readonly MaterialParameter[] = Object.freeze([
  numeric('underwaterAbsorptionPerM', 'vec3', [1 / 3, 1 / 15, 2 / 75]),
  numeric('underwaterFogPerM', 'f32', 0.02),
  numeric('underwaterMaximumDistanceM', 'f32', 2500),
  numeric('underwaterAmbientColor', 'vec3', [0.025, 0.1, 0.1875]),
  numeric('underwaterScatterColor', 'vec3', [1.5, 3, 2.25]),
  numeric('underwaterPhaseG', 'f32', 0.2),
  numeric('underwaterNearPlaneM', 'f32', 0.1),
  numeric('underwaterWetAlphaM', 'f32', 0.002),
  numeric('underwaterWetLocationM', 'f32', 0),
  numeric('underwaterWetRadiusM', 'f32', 0.01),
  numeric('underwaterWetHardness', 'f32', 0.25),
  numeric('underwaterBandWidthM', 'f32', 0.01),
  numeric('underwaterBandOffset', 'f32', 0.5),
  numeric('underwaterBandColor', 'vec3', [0.08, 1.6, 2.4]),
  numeric('underwaterBandOpacity', 'f32', 1),
  numeric('maximumFlowVelocityMPerSec', 'f32', 10.24),
]);

/** Ordinary root/child assets with consumer-authored Pack texture references. */
export function buildWaterMaterialFamily(
  packageId: PackageId,
  prefix = 'material/water',
  values: Readonly<Record<string, MaterialValue>> = {},
): WaterMaterialFamily {
  const guids = Object.fromEntries(
    WATER_MATERIAL_FAMILY_KEYS.map((key) => [
      key,
      AssetGuid.format(AssetGuid.derive(packageId, `${prefix}/${key}`)),
    ]),
  ) as Record<WaterMaterialFamilyKey, string>;
  const assets: Partial<Record<WaterMaterialFamilyKey, MaterialAsset>> = {};
  const child = (
    parent: WaterMaterialFamilyKey,
    values: Readonly<Record<string, MaterialValue>> = {},
    staticSwitches?: MaterialStaticSwitches,
  ): MaterialAsset => ({
    kind: 'material',
    parent: guids[parent],
    values,
    ...(staticSwitches === undefined ? {} : { staticSwitches }),
  });
  assets.root = {
    kind: 'material',
    colorSpace: 'linear',
    parameters: WATER_SURFACE_PARAMETERS,
    values,
    surface: {
      model: 'single-layer-water',
      module: 'forgeax_material::water_surface',
      deformation: {
        module: 'forgeax_material::water_deformation_default',
        version: WATER_DEFORMATION_VERSION,
        inputs: WATER_DEFORMATION_INPUTS,
      },
    },
    staticSwitches: {
      waterWaves: true,
      waterVertexMapping: true,
      waterDynamicBoundsClip: true,
      waterInfo: true,
      waterBakedSimulation: false,
      waterShallowSimulation: false,
      waterShallowAdditive: false,
      waterOceanPatch: false,
      waterVisualNormalDetail: false,
      waterOceanDisplacement: false,
      waterFixedVelocity: false,
      waterFixedHeight: false,
      waterFixedDepth: false,
      waterFlowmap: values.waterFlowNormalTexture !== undefined,
      waterNormalTexture: values.waterNormalTexture !== undefined,
      waterFoam: values.waterFoamTexture !== undefined,
      waterRefraction: true,
      waterReflections: true,
      waterSsr: true,
      waterRiver: false,
      waterOceanFoam: false,
    },
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::single-layer-water' },
        renderState: {
          tags: { LightMode: 'Forward' },
          queue: 2000,
          cullMode: 'none',
          depthWriteEnabled: true,
        },
      },
      {
        name: 'shadow',
        program: {
          module: 'forgeax::single-layer-water',
          vertexEntry: 'vs_water_shadow',
          fragmentEntry: 'fs_water_shadow',
        },
        renderState: {
          tags: { LightMode: 'ShadowCaster' },
          cullMode: 'none',
          depthWriteEnabled: true,
        },
      },
    ],
  };
  assets.instance = child('root', {}, { waterWaves: true, waterInfo: true });
  assets.river = child(
    'instance',
    {
      flowmapDepthBiasM: 0.96,
      flowmapDepthDensityPerM: 0.5,
      flowmapDetectionVelocityMPerSec: 0.64,
      flowmapSpeed: 0.002,
      riverNormalTilingM: 15.36,
      normalFlatness: 0.5,
      refractionDepthBias: 0,
      flowmapFlip: [1, -1, 0, 0],
    },
    { waterWaves: false, waterRiver: true, waterFlowmap: true },
  );
  assets.lake = child(
    'instance',
    { simulationFoamContrast: 0.2, refractionDepthBias: 0 },
    { waterWaves: true },
  );
  assets.ocean = child(
    'instance',
    { refractionDepthBias: 0 },
    { waterWaves: true, waterOceanFoam: true },
  );
  assets.custom = child(
    'root',
    {},
    {
      waterWaves: true,
      waterVertexMapping: false,
      waterDynamicBoundsClip: false,
      waterInfo: false,
      waterFixedHeight: true,
      waterFixedDepth: true,
    },
  );
  assets['river-to-lake'] = child('river', {}, { waterTransitionLake: true, waterInfo: true });
  assets['river-to-ocean'] = child(
    'river',
    {},
    { waterTransitionOcean: true, waterOceanFoam: true, waterInfo: true },
  );
  for (const body of ['river', 'lake', 'ocean', 'custom'] as const)
    assets[`${body}-lod`] = child(body, {}, { waterInfo: false, waterVertexMapping: false });
  assets.far = child(
    'root',
    {},
    {
      waterWaves: false,
      waterVertexMapping: false,
      waterDynamicBoundsClip: false,
      waterInfo: false,
      waterFixedHeight: true,
      waterFixedDepth: true,
    },
  );
  assets.hlod = child('far');
  assets['water-info'] = {
    kind: 'material',
    colorSpace: 'linear',
    passes: [
      {
        name: 'water-info',
        program: { module: 'forgeax_material::water_info_raster_water', bindings: 'group-0' },
        outputs: [{ name: 'waterInfo', format: 'rgba16float' }],
        renderState: {
          tags: { LightMode: 'WaterInfo' },
          cullMode: 'none',
          depthCompare: 'greater',
          depthWriteEnabled: true,
        },
      },
    ],
  };
  assets.underwater = {
    kind: 'material',
    colorSpace: 'linear',
    parameters: WATER_UNDERWATER_PARAMETERS,
    staticSwitches: {
      waterInfo: true,
      waterBakedSimulation: false,
      waterFixedVelocity: false,
      waterFixedHeight: false,
      waterFixedDepth: false,
    },
    passes: [
      {
        name: 'underwater',
        program: {
          module: 'forgeax_material::water_underwater',
          bindings: 'post-process',
          sceneDepth: 'before-pass',
          postProcess: {
            placement: 'after-tonemap',
            input: 'current-output',
            output: 'current-output',
          },
        },
        outputs: [{ name: 'color', format: 'rgba16float', writeMask: 7 }],
        renderState: {
          tags: { LightMode: 'PostProcess' },
          cullMode: 'none',
          depthWriteEnabled: false,
        },
      },
    ],
  };
  assets['custom-underwater'] = child(
    'underwater',
    {},
    { waterInfo: false, waterFixedHeight: true, waterFixedDepth: true },
  );
  return Object.freeze({
    guids: Object.freeze(guids),
    outputs: Object.freeze(
      Object.fromEntries(
        WATER_MATERIAL_FAMILY_KEYS.map((key) => {
          const asset = assets[key];
          if (asset === undefined) throw new Error(`Missing Water material family member ${key}`);
          return [`${prefix}/${key}`, asset];
        }),
      ),
    ),
  });
}

/** Body slots keep independent material identities even when their roots are shared. */
export function waterMaterialFamilySlots(
  family: Pick<WaterMaterialFamily, 'guids'>,
  type: 'river' | 'lake' | 'ocean' | 'custom',
): Readonly<{
  surfaceMaterialGuid: string;
  waterInfoMaterialGuid: string;
  lodMaterialGuid: string;
  underwaterPostProcessMaterialGuid: string;
  riverToLakeTransitionMaterialGuid?: string;
  riverToOceanTransitionMaterialGuid?: string;
}> {
  return Object.freeze({
    surfaceMaterialGuid: family.guids[type],
    waterInfoMaterialGuid: family.guids['water-info'],
    lodMaterialGuid: family.guids[`${type}-lod`],
    underwaterPostProcessMaterialGuid:
      family.guids[type === 'custom' ? 'custom-underwater' : 'underwater'],
    ...(type === 'river'
      ? {
          riverToLakeTransitionMaterialGuid: family.guids['river-to-lake'],
          riverToOceanTransitionMaterialGuid: family.guids['river-to-ocean'],
        }
      : {}),
  });
}
