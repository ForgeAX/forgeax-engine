import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { Atmosphere, VolumetricCloudLayer } from '@forgeax/engine/render';
import { Name } from '@forgeax/engine/scene';
import { referenceTexture } from './reference-textures.ts';
import { cloudGuid as guid } from './identity.ts';
import { UE_CLOUD_SCENE_PRESET } from './ue-reference.ts';
export {
  analyticUniformCloudRef, referenceCloudRef, bandCloudRef, bandWideInstanceRef,
} from './identity.ts';

const packageId = definePackageId('019a50a5-0000-7000-8000-000000000004');

const analyticUniformKey = 'material/analytic-uniform';
const referenceMaterialKey = 'material/reference-layout';

export const referenceParameters = {
  layoutScaleMeters: { kind: 'scalar', default: 256_000, unit: 'm', range: [1, 1_000_000] },
  coverageBias: { kind: 'scalar', default: -0.20000000298023224, unit: 'unitless', range: [-1, 1] },
  extinctionPerMeter: { kind: 'scalar', default: 0.008, unit: 'm^-1', range: [0, 1] },
  albedo: { kind: 'vector', default: [0.9800000190734863, 0.9800000190734863, 0.9800000190734863, 0.5] },
  layoutWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  maskWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  profileWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  bodyWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  erosionWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  useDetail: { kind: 'static', default: false },
  layoutPattern: { kind: 'texture', default: guid('texture/layout-pattern'), dimension: '2d', colorSpace: 'linear', mipLevels: 1 },
  layoutMask: { kind: 'texture', default: guid('texture/layout-mask'), dimension: '2d', colorSpace: 'linear', mipLevels: 1 },
  heightProfile: { kind: 'texture', default: guid('texture/height-profile'), dimension: '2d', colorSpace: 'linear', mipLevels: 1 },
  bodyNoise: { kind: 'texture', default: guid('texture/body-noise'), dimension: '3d', colorSpace: 'linear', mipLevels: 1 },
} as const;

const bandParameters = {
  centerMeters: { kind: 'scalar', default: 0, unit: 'm', range: [-100_000, 100_000] },
  halfWidthMeters: { kind: 'scalar', default: 800, unit: 'm', range: [1, 100_000] },
  extinctionPerMeter: { kind: 'scalar', default: 0.002, unit: 'm^-1', range: [0, 1] },
} as const;

function material(source: object) {
  return { kind: 'cloud-material', execution: 'cooked', source } as const;
}

function instance(source: object) {
  return { kind: 'cloud-material-instance', execution: 'cooked', source } as const;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  sceneComponents: [Name, Atmosphere, VolumetricCloudLayer],
  parameters: [
    { name: 'seed', type: 'u32', default: 0x4e554245, minimum: 0, maximum: 4294967295 },
    { name: 'resolution', type: 'enum', default: 'standard', values: ['standard', 'preview'] },
    { name: 'patternFrequency', type: 'u32', default: 8, minimum: 2, maximum: 32 },
    { name: 'patternCoverage', type: 'f32', default: 0.5, minimum: 0, maximum: 1 },
    { name: 'maskFrequency', type: 'u32', default: 4, minimum: 2, maximum: 32 },
    { name: 'maskContrast', type: 'f32', default: 1, minimum: 0.1, maximum: 4 },
    { name: 'profileBaseOffset', type: 'f32', default: 0, minimum: -0.25, maximum: 0.25 },
    { name: 'profileThickness', type: 'f32', default: 1, minimum: 0.25, maximum: 2 },
    { name: 'profileSoftness', type: 'f32', default: 0.15, minimum: 0.01, maximum: 0.4 },
    { name: 'bodyFrequency', type: 'u32', default: 4, minimum: 2, maximum: 32 },
    { name: 'bodyWorleyMix', type: 'f32', default: 0.5, minimum: 0, maximum: 1 },
    { name: 'bodyDetail', type: 'f32', default: 0.35, minimum: 0, maximum: 1 },
  ] as const,
  build: ({ values }) => ok({
    'scene/sky': {
      kind: 'scene',
      entities: {
        atmosphere: { components: {
          Name: { value: 'Cloud Atmosphere' },
          Atmosphere: { backgroundOnly: false },
        } },
        clouds: { components: {
          Name: { value: 'Procedural Volumetric Clouds' },
          VolumetricCloudLayer: {
            material: guid(referenceMaterialKey),
            ...UE_CLOUD_SCENE_PRESET,
            requestRevision: 1,
          },
        } },
      },
    },
    'texture/layout-pattern': referenceTexture('pattern', values),
    'texture/layout-mask': referenceTexture('mask', values),
    'texture/height-profile': referenceTexture('profile', values),
    'texture/body-noise': referenceTexture('body', values),
    [analyticUniformKey]: material({
      version: 1,
      model: {
        kind: 'uniform',
        sample: {
          extinctionPerMeter: 0.00012,
          albedo: [0.95, 0.95, 0.95],
          emissivePerMeter: [0, 0, 0],
          materialAO: 1,
        },
      },
      parameters: {},
    }),
    [referenceMaterialKey]: material({
      version: 1, model: { kind: 'program', source: 'reference-layout.wgsl' }, parameters: referenceParameters,
    }),
    'instance/reference-default': instance({
      version: 1, material: guid(referenceMaterialKey), parameters: referenceParameters, overrides: {},
    }),
    'instance/reference-detail': instance({
      version: 1, material: guid(referenceMaterialKey), parameters: referenceParameters, overrides: { useDetail: true },
    }),
    'material/cloud-band': material({
      version: 1, model: { kind: 'program', source: 'cloud-band.wgsl' }, parameters: bandParameters,
    }),
    'instance/cloud-band-wide': instance({
      version: 1, material: guid('material/cloud-band'), parameters: bandParameters, overrides: { halfWidthMeters: 1600 },
    }),
  }),
});
