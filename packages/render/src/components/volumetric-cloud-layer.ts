import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import type { AssetHandle } from '@forgeax/engine-types';

/** One cooked cloud layer; lengths are meters and extinction is inverse meters. */
export const VolumetricCloudLayer = defineComponent('VolumetricCloudLayer', {
  material: { type: 'asset<cloud-material>' },
  materialInstance: {
    type: 'asset<cloud-material-instance>',
    default: 0 as AssetHandle<'cloud-material-instance'>,
  },
  enabled: { type: 'bool', default: true },
  bottomMeters: { type: 'f32', default: 5000 },
  thicknessMeters: { type: 'f32', default: 10000 },
  /** Negative selects the cooked material's extinction. */
  extinctionOverridePerMeter: { type: 'f32', default: -1 },
  entryLimitMeters: { type: 'f32', default: 350000 },
  traceLimitMeters: { type: 'f32', default: 200000 },
  viewSampleCountScale: { type: 'f32', default: 1 },
  stopTransmittance: { type: 'f32', default: 0.005 },
  layoutWeight: { type: 'f32', default: -1 },
  maskWeight: { type: 'f32', default: -1 },
  profileWeight: { type: 'f32', default: -1 },
  bodyWeight: { type: 'f32', default: -1 },
  erosionWeight: { type: 'f32', default: -1 },
  /** -2 selects the Cook value; [-1, 1] is the signed coverage bias. */
  coverageBias: { type: 'f32', default: -2 },
  windOffsetMeters: { type: 'array<f32, 3>', default: new Float32Array(3) },
  /** 0/1 select a Cook variant; 2 selects its material default. */
  useDetail: { type: 'u32', default: 2 },
  skipEmpty: { type: 'bool', default: true },
  selfShadow: { type: 'bool', default: true },
  multiScatteringOctaves: { type: 'u32', default: 2 },
  shadowSamples: { type: 'u32', default: 10 },
  shadowDistanceMeters: { type: 'f32', default: 15000 },
  /** 0: secondary raymarch, 1: Beer shadow map. */
  shadowMode: { type: 'u32', default: 0 },
  castCloudShadows: { type: 'bool', default: true },
  shadowExtentMeters: { type: 'f32', default: 40000 },
  /** Distance from the ground anchor toward the light; independent of lateral full width. */
  shadowLightDistanceMeters: { type: 'f32', default: 300000 },
  /** Finite trace depth measured from the light plane. */
  shadowFarDepthMeters: { type: 'f32', default: 600000 },
  shadowDepthBiasMeters: { type: 'f32', default: 0 },
  shadowStrength: { type: 'f32', default: 1 },
  surfaceShadowStrength: { type: 'f32', default: 1 },
  atmosphereShadowStrength: { type: 'f32', default: 1 },
  atmosphereTransmittanceMode: { type: 'u32', default: 0 },
  enableDistantSkyLightSampling: { type: 'bool', default: true },
  /** Raw BSM side length; encoded 2x2 filtering produces ceil(N/2) receiver texels. */
  shadowResolution: { type: 'u32', default: 128 },
  shadowMapSamples: { type: 'u32', default: 64 },
  phaseG: { type: 'f32', default: 0.15 },
  phaseG2: { type: 'f32', default: -0.2 },
  phaseBlend: { type: 'f32', default: 0 },
  msContribution: { type: 'f32', default: 0.5 },
  msOcclusion: { type: 'f32', default: 0.5 },
  msEccentricity: { type: 'f32', default: 0.5 },
  /** Nonzero application revision to correlate a request with completed renderer adoption. */
  requestRevision: { type: 'u32', default: 0 },
  /** Explicit discontinuous initialization; continuous wind/time leaves this unchanged. */
  initializationRevision: { type: 'u32', default: 0 },
  /** 1/2 inspect one pixel; 3/4 display transmittance/contour without changing L/T. */
  diagnosticMode: { type: 'u32', default: 0 },
  diagnosticPixelX: { type: 'u32', default: 0 },
  diagnosticPixelY: { type: 'u32', default: 0 },
});

export type VolumetricCloudLayerData = ShapeOf<SchemaOf<typeof VolumetricCloudLayer>>;
