import type { CloudMaterialSource, CloudParameter } from '@forgeax/engine/render/authoring';
import { standardUeGuid } from './identity.ts';
import { textureSources } from './texture-definitions.ts';

const parameters: Record<string, CloudParameter> = {
  layoutScaleMeters: { kind: 'scalar', default: 256_000, unit: 'm', range: [1, 1_000_000] },
  coverageBias: { kind: 'scalar', default: -0.20000000298023224, unit: 'unitless', range: [-1, 1] },
  extinctionPerMeter: { kind: 'scalar', default: 0.00800000037997961, unit: 'm^-1', range: [0, 1] },
  albedo: { kind: 'vector', default: [0.9800000190734863, 0.9800000190734863, 0.9800000190734863, 0.5] },
  layoutWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  maskWeight: { kind: 'scalar', default: 0, unit: 'unitless', range: [0, 1] },
  profileWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  bodyWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  erosionWeight: { kind: 'scalar', default: 1, unit: 'unitless', range: [0, 1] },
  useDetail: { kind: 'static', default: false },
  ...Object.fromEntries(textureSources.map(recipe => [recipe.parameter, {
    kind: 'texture', default: standardUeGuid(recipe.key), dimension: recipe.dimension, colorSpace: 'linear', mipLevels: 1,
  }])),
};
const layoutLabels: Record<string, string> = {
  layoutPattern: 'Layout_CloudGlobalPattern', layoutMask: 'Layout_GlobalCloudMask', heightProfile: 'Layout_CloudHeightProfile',
  layoutScaleMeters: 'Layout_CloudGlobalScale', coverageBias: 'Cloud_GlobalCoverage',
  layoutWeight: 'Layout_PatternWeight', maskWeight: 'Layout_MaskWeight', profileWeight: 'Layout_ProfileWeight',
};
const shapeLabels: Record<string, string> = {
  bodyNoise: 'Noise_Texture3D', extinctionPerMeter: 'Cloud_GlobalDensity', albedo: 'Cloud_AlbedoColor',
  bodyWeight: 'Noise_Strength', erosionWeight: 'Noise_ErosionWeight', useDetail: 'UseNoise3',
};

export default {
  version: 1, model: { kind: 'program', source: 'reference-layout.wgsl' },
  parameters: Object.fromEntries(Object.entries(parameters).map(([name, parameter]) => [name, {
    ...parameter, label: layoutLabels[name] ?? shapeLabels[name],
    group: layoutLabels[name] ? '00 - Cloud Layout' : '01 - Cloud Shape',
  }])),
} satisfies CloudMaterialSource;
