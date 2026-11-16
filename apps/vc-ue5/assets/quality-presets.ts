import type { CloudEdit } from './cloud-controls.ts';
import type { CloudParameterKey } from './parameter-labels.ts';
import { WEATHER_PRESETS } from './weather-presets.ts';

export const QUALITY_PRESET_IDS = ['quality-low', 'quality-medium', 'quality-high'] as const;
export type QualityPresetId = typeof QUALITY_PRESET_IDS[number];

export const QUALITY_PARAMETER_KEYS = [
  'viewSampleCountScale', 'stopTransmittance', 'selfShadow', 'shadowMode', 'shadowSamples',
  'shadowDistanceMeters', 'shadowResolution', 'shadowMapSamples', 'shadowExtentMeters',
  'shadowLightDistanceMeters', 'shadowFarDepthMeters',
  'multiScatteringOctaves', 'atmosphereTransmittanceMode', 'enableDistantSkyLightSampling',
  'groundShadowEnabled', 'atmosphereShadowEnabled', 'surfaceShadowStrength', 'atmosphereShadowStrength',
  'shadowStrength', 'shadowDepthBiasMeters', 'useDetail', 'skipEmpty', 'entryLimitMeters', 'traceLimitMeters',
] as const satisfies readonly CloudParameterKey[];
type QualityParameters = Required<Pick<CloudEdit, typeof QUALITY_PARAMETER_KEYS[number]>>;

function qualityPreset(label: string, parameters: CloudEdit) {
  const clear = WEATHER_PRESETS.clear.forgeax.parameters;
  return Object.freeze({
    label,
    parameters: Object.freeze(Object.fromEntries(QUALITY_PARAMETER_KEYS.map(key =>
      [key, key === 'skipEmpty' ? true : parameters[key] ?? clear[key]])) as QualityParameters),
  });
}

export const QUALITY_PRESETS = Object.freeze({
  'quality-low': qualityPreset('低', {
    viewSampleCountScale: 0.5, stopTransmittance: 0.02,
    shadowMode: 1, shadowResolution: 64, shadowMapSamples: 16,
    multiScatteringOctaves: 1, atmosphereShadowEnabled: false,
  }),
  'quality-medium': qualityPreset('中', {
    viewSampleCountScale: 1, stopTransmittance: 0.01,
    shadowMode: 1, shadowResolution: 128, shadowMapSamples: 128,
  }),
  'quality-high': qualityPreset('高', {
    viewSampleCountScale: 2, stopTransmittance: 0.005,
    shadowMode: 0, shadowSamples: 12, shadowResolution: 256, shadowMapSamples: 64,
    atmosphereTransmittanceMode: 1,
  }),
});

export function readQualityPreset(value: unknown): (typeof QUALITY_PRESETS)[QualityPresetId] | undefined {
  return typeof value === 'string' && Object.hasOwn(QUALITY_PRESETS, value)
    ? QUALITY_PRESETS[value as QualityPresetId] : undefined;
}

export function matchQualityPreset(fields: Partial<QualityParameters>): QualityPresetId | null {
  return QUALITY_PRESET_IDS.find(id => QUALITY_PARAMETER_KEYS.every(key => {
    const expected = QUALITY_PRESETS[id].parameters[key];
    const actual = fields[key];
    return typeof expected === 'boolean' ? actual === expected
      : typeof actual === 'number' && Math.fround(actual) === Math.fround(expected);
  })) ?? null;
}
