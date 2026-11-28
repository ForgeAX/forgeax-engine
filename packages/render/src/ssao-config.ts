// @forgeax/engine-render - SSAO parameter authority.

import {
  type CompactGBufferLayout,
  err,
  type MaterialGBufferLayout,
  ok,
  type RenderPipelineAsset,
  type Result,
} from '@forgeax/engine-types';
import { PostProcessError } from './post-process-errors';

export const SSAO_DEFAULT_RADIUS = 2;
export const SSAO_DEFAULT_BIAS = 3;
export const SSAO_DEFAULT_INTENSITY = 0.5;
export const DEFAULT_AMBIENT_OCCLUSION_METHOD = 'ssao';

export type DeferredAoNormalLayout = MaterialGBufferLayout | CompactGBufferLayout;

export type AmbientOcclusionSettings = NonNullable<
  NonNullable<RenderPipelineAsset['config']>['ambientOcclusion']
>;
export type SsaoParameterConfig = Omit<AmbientOcclusionSettings, 'enabled'>;

// Retained by the low-level legacy shader fixtures. Stock profile validation
// accepts only the published AO contract.
interface LegacySsaoProgramOptions {
  readonly method?: 'ssao' | 'gtao' | undefined;
  readonly sampleCount?: number;
  readonly thickness?: number;
  readonly distanceExponent?: number;
  readonly distanceFallOff?: number;
  readonly resolutionScale?: number;
}

type SsaoProgramConfig = Omit<SsaoParameterConfig, 'method'> & LegacySsaoProgramOptions;

export const GTAO_SAMPLE_COUNTS = { low: 4, medium: 10, high: 16 } as const;
export const SSAO_DEFAULT_THICKNESS = 1;
export const SSAO_DEFAULT_DISTANCE_EXPONENT = 1;
export const SSAO_DEFAULT_DISTANCE_FALL_OFF = 1;
export const SSAO_DEFAULT_RESOLUTION_SCALE = 1;

export const SSAO_SAMPLE_COUNTS = { low: 16, medium: 32, high: 64 } as const;

interface ResolvedSsaoParameters {
  readonly method: NonNullable<SsaoProgramConfig['method']>;
  readonly levels: SsaoParameterConfig['levels'];
  readonly gtao: Required<NonNullable<SsaoParameterConfig['gtao']>>;
  readonly maxQuality: number;
  readonly power: number;
  readonly fadeDistance: number;
  readonly fadeRadius: number;
  readonly radiusInWorldSpace: boolean;
  readonly mipBlend: number;
  readonly mipScale: number;
  readonly mipThreshold: number;
  readonly sampleCount: number;
  readonly radius: number;
  readonly bias: number;
  readonly intensity: number;
  readonly thickness: number;
  readonly distanceExponent: number;
  readonly distanceFallOff: number;
  readonly resolutionScale: number;
  readonly quality: NonNullable<SsaoParameterConfig['quality']>;
}

export const GTAO_DEFAULTS = {
  useNormals: false,
  downsample: false,
  spatialFilter: true,
  temporalFilter: true,
  filterWidth: 5,
  numAngles: 2,
  thicknessBlend: 0.5,
  falloffEnd: 2,
  temporalBlendWeight: 0.1,
} as const satisfies ResolvedSsaoParameters['gtao'];

export const AO_APPEARANCE_DEFAULTS = {
  intensity: SSAO_DEFAULT_INTENSITY,
  power: 2,
  fadeDistance: 80,
  fadeRadius: 50,
} as const;

const GTAO_PARAMETER_KEYS = Object.keys(GTAO_DEFAULTS) as (keyof typeof GTAO_DEFAULTS)[];
const AO_APPEARANCE_KEYS = Object.keys(
  AO_APPEARANCE_DEFAULTS,
) as (keyof typeof AO_APPEARANCE_DEFAULTS)[];

export const GTAO_HISTORY_PARAMETER_COUNT =
  1 + AO_APPEARANCE_KEYS.length + GTAO_PARAMETER_KEYS.length;

export function writeGtaoHistoryParameters(
  out: Float64Array,
  settings: AmbientOcclusionSettings | undefined,
): void {
  out[0] = ssaoQualityPermutation(settings);
  let index = 1;
  for (const key of AO_APPEARANCE_KEYS)
    out[index++] = settings?.[key] ?? AO_APPEARANCE_DEFAULTS[key];
  for (const key of GTAO_PARAMETER_KEYS)
    out[index++] = Number(settings?.gtao?.[key] ?? GTAO_DEFAULTS[key]);
}

function getGtaoParameters(config: SsaoParameterConfig['gtao']): ResolvedSsaoParameters['gtao'] {
  return {
    useNormals: config?.useNormals ?? GTAO_DEFAULTS.useNormals,
    downsample: config?.downsample ?? GTAO_DEFAULTS.downsample,
    spatialFilter: config?.spatialFilter ?? GTAO_DEFAULTS.spatialFilter,
    temporalFilter: config?.temporalFilter ?? GTAO_DEFAULTS.temporalFilter,
    filterWidth: config?.filterWidth ?? GTAO_DEFAULTS.filterWidth,
    numAngles: config?.numAngles ?? GTAO_DEFAULTS.numAngles,
    thicknessBlend: config?.thicknessBlend ?? GTAO_DEFAULTS.thicknessBlend,
    falloffEnd: config?.falloffEnd ?? GTAO_DEFAULTS.falloffEnd,
    temporalBlendWeight: config?.temporalBlendWeight ?? GTAO_DEFAULTS.temporalBlendWeight,
  };
}

function resolveLegacySampleCount(
  config: SsaoProgramConfig | undefined,
  method: ResolvedSsaoParameters['method'],
  quality: ResolvedSsaoParameters['quality'],
): number {
  const counts = method === 'gtao' ? GTAO_SAMPLE_COUNTS : SSAO_SAMPLE_COUNTS;
  return config?.sampleCount ?? counts[typeof quality === 'number' ? 'high' : quality];
}

/**
 * Apply the public defaults without deciding whether the values are valid.
 * The record stage uses this only after the graph build has validated the
 * active Standard configuration, or for the disabled/default fallback payload.
 */
export function getSsaoParameters(config: SsaoProgramConfig | undefined): ResolvedSsaoParameters {
  const method = config?.method ?? DEFAULT_AMBIENT_OCCLUSION_METHOD;
  const quality = config?.quality ?? 50;
  return {
    method,
    levels: config?.levels,
    gtao: getGtaoParameters(config?.gtao),
    maxQuality: config?.maxQuality ?? 100,
    power: config?.power ?? AO_APPEARANCE_DEFAULTS.power,
    fadeDistance: config?.fadeDistance ?? AO_APPEARANCE_DEFAULTS.fadeDistance,
    fadeRadius: config?.fadeRadius ?? AO_APPEARANCE_DEFAULTS.fadeRadius,
    radiusInWorldSpace: config?.radiusInWorldSpace ?? false,
    mipBlend: config?.mipBlend ?? 0.6,
    mipScale: config?.mipScale ?? 1.7,
    mipThreshold: config?.mipThreshold ?? 0.01,
    sampleCount: resolveLegacySampleCount(config, method, quality),
    radius: config?.radius ?? SSAO_DEFAULT_RADIUS,
    bias: config?.bias ?? SSAO_DEFAULT_BIAS,
    intensity: config?.intensity ?? AO_APPEARANCE_DEFAULTS.intensity,
    thickness: config?.thickness ?? SSAO_DEFAULT_THICKNESS,
    distanceExponent: config?.distanceExponent ?? SSAO_DEFAULT_DISTANCE_EXPONENT,
    distanceFallOff: config?.distanceFallOff ?? SSAO_DEFAULT_DISTANCE_FALL_OFF,
    resolutionScale: config?.resolutionScale ?? SSAO_DEFAULT_RESOLUTION_SCALE,
    quality,
  };
}

function invalidSsaoMode(resolved: ResolvedSsaoParameters): PostProcessError | undefined {
  if (resolved.method !== 'ssao' && resolved.method !== 'gtao') {
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'method', value: resolved.method },
    });
  }
  return undefined;
}

function invalidSsaoSampling(resolved: ResolvedSsaoParameters): PostProcessError | undefined {
  if (
    !Number.isInteger(resolved.sampleCount) ||
    resolved.sampleCount < 1 ||
    resolved.sampleCount > 64
  ) {
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'sampleCount', value: resolved.sampleCount },
    });
  }
  for (const [paramName, min, max] of [
    ['thickness', 0, Number.POSITIVE_INFINITY],
    ['distanceExponent', 0, Number.POSITIVE_INFINITY],
    ['distanceFallOff', 0, 1],
    ['resolutionScale', 0.25, 1],
  ] as const) {
    const value = resolved[paramName];
    if (!Number.isFinite(value) || value < min || value > max) {
      return new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName, value },
      });
    }
  }
  return undefined;
}

/**
 * Resolve and validate the SSAO configuration used by both graph routes.
 * Invalid values remain structured PostProcessErrors instead of becoming
 * NaNs or silently falling back to shader literals.
 */
export function resolveSsaoParameters(
  config: SsaoProgramConfig | undefined,
): Result<ResolvedSsaoParameters, PostProcessError> {
  const resolved = getSsaoParameters(config);
  const modeFailure = invalidSsaoMode(resolved);
  if (modeFailure !== undefined) return err(modeFailure);
  if (!Number.isFinite(resolved.radius) || resolved.radius <= 0) {
    return err(
      new PostProcessError({
        code: 'ssao-radius-non-positive',
        detail: { paramName: 'radius', value: resolved.radius },
      }),
    );
  }
  if (!Number.isFinite(resolved.bias) || resolved.bias < 0) {
    return err(
      new PostProcessError({
        code: 'ssao-bias-negative',
        detail: { paramName: 'bias', value: resolved.bias },
      }),
    );
  }
  if (
    !Number.isFinite(resolved.intensity) ||
    resolved.intensity < 0 ||
    (typeof resolved.quality === 'number'
      ? !Number.isFinite(resolved.quality) || resolved.quality < 0 || resolved.quality > 100
      : !Object.hasOwn(SSAO_SAMPLE_COUNTS, resolved.quality))
  ) {
    const paramName =
      !Number.isFinite(resolved.intensity) || resolved.intensity < 0 ? 'intensity' : 'quality';
    return err(
      new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName, value: resolved[paramName] },
      }),
    );
  }
  const parameterFailure = invalidSsaoFilterSettings(config);
  if (parameterFailure !== undefined) return err(parameterFailure);
  const gtaoFailure = config?.gtao === undefined ? undefined : invalidGtaoSettings(resolved.gtao);
  if (gtaoFailure !== undefined) return err(gtaoFailure);
  const samplingFailure = invalidSsaoSampling(resolved);
  if (samplingFailure !== undefined) return err(samplingFailure);
  return ok(resolved);
}

function invalidSsaoFilterSettings(
  config: SsaoProgramConfig | undefined,
): PostProcessError | undefined {
  for (const [name, min, max] of [
    ['power', 0, 100],
    ['maxQuality', -100, 100],
    ['fadeDistance', 0.01, Number.MAX_VALUE],
    ['fadeRadius', 0.01, Number.MAX_VALUE],
    ['mipBlend', 0, 1],
    ['mipScale', 0.001, 10],
    ['mipThreshold', 0, 1],
  ] as const) {
    const value = config?.[name];
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max))
      return new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName: name, value },
      });
  }
  const levels = config?.levels;
  if (levels !== undefined && ![0, 1, 2, 3].includes(levels))
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'levels', value: levels },
    });
  return undefined;
}

function invalidGtaoSettings(gtao: ResolvedSsaoParameters['gtao']): PostProcessError | undefined {
  for (const name of ['useNormals', 'downsample', 'spatialFilter', 'temporalFilter'] as const) {
    if (typeof gtao[name] !== 'boolean')
      return new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName: `gtao.${name}`, value: gtao[name] },
      });
  }
  for (const [name, min, max] of [
    ['filterWidth', 4, 5],
    ['numAngles', 1, 16],
    ['thicknessBlend', 0, 1],
    ['falloffEnd', 0.01, Number.MAX_VALUE],
    ['temporalBlendWeight', 0.01, 1],
  ] as const) {
    const value = gtao[name];
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      ((name === 'filterWidth' || name === 'numAngles') && !Number.isInteger(value))
    )
      return new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName: `gtao.${name}`, value },
      });
  }
  return undefined;
}

export function ssaoUsesLighting(
  config: NonNullable<RenderPipelineAsset['config']>['ambientOcclusion'],
): boolean {
  return config?.enabled === true && config.levels !== 0 && config.intensity !== 0;
}

function effectiveSsaoQuality(config: SsaoParameterConfig | undefined): number {
  const authored = config?.quality ?? 50;
  const quality =
    typeof authored === 'number' ? authored : { low: 20, medium: 50, high: 100 }[authored];
  const ceiling = config?.maxQuality ?? 100;
  return ceiling < 0 ? -ceiling : Math.min(quality, ceiling);
}

function permutationForQuality(effective: number): number {
  return (
    Number(effective > 5) + Number(effective > 25) + Number(effective > 55) + Number(effective > 75)
  );
}

export function ssaoQualityPermutation(config: SsaoParameterConfig | undefined): number {
  return permutationForQuality(effectiveSsaoQuality(config));
}

/** Shader permutation, spatial level count and graphics preset limit are distinct. */
export function resolveSsaoQuality(config: SsaoParameterConfig | undefined) {
  const effective = effectiveSsaoQuality(config);
  return {
    permutation: permutationForQuality(effective),
    levels: config?.levels ?? 1 + Number(effective > 35) + Number(effective > 70),
  };
}

const STANDARD_AO_FIELDS = [
  'enabled',
  'method',
  'radius',
  'bias',
  'intensity',
  'quality',
  'maxQuality',
  'levels',
  'power',
  'fadeDistance',
  'fadeRadius',
  'radiusInWorldSpace',
  'mipBlend',
  'mipScale',
  'mipThreshold',
  'gtao',
] as const satisfies readonly (keyof AmbientOcclusionSettings)[];
const STANDARD_AO_KEYS = new Set<string>(STANDARD_AO_FIELDS);

export function sameAmbientOcclusionSettings(
  previous: AmbientOcclusionSettings | undefined,
  current: AmbientOcclusionSettings | undefined,
): boolean {
  if (previous === current) return true;
  if (previous === undefined || current === undefined) return false;
  for (const key of STANDARD_AO_FIELDS) {
    if (key !== 'gtao' && previous[key] !== current[key]) return false;
  }
  const before = previous.gtao;
  const after = current.gtao;
  if (before === after) return true;
  if (before === undefined || after === undefined) return false;
  for (const key of GTAO_PARAMETER_KEYS) {
    if (before[key] !== after[key]) return false;
  }
  return true;
}

const GTAO_KEYS = new Set<string>(GTAO_PARAMETER_KEYS);

export function hasStandardAoKeys(config: AmbientOcclusionSettings): boolean {
  return (
    Object.keys(config).every((name) => STANDARD_AO_KEYS.has(name)) &&
    (config.method === undefined || config.method === 'ssao' || config.method === 'gtao') &&
    (config.radiusInWorldSpace === undefined || typeof config.radiusInWorldSpace === 'boolean') &&
    (config.gtao === undefined ||
      (config.method === 'gtao' &&
        typeof config.gtao === 'object' &&
        config.gtao !== null &&
        !Array.isArray(config.gtao) &&
        Object.keys(config.gtao).every((name) => GTAO_KEYS.has(name))))
  );
}

/** Saved estimator-specific numbers cannot be read with the new UE meanings. */
export function migrateSavedAmbientOcclusion(value: unknown, oldRoute = false): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const direct = source.directLightingStrength;
  if (
    direct !== undefined &&
    (typeof direct !== 'number' || !Number.isFinite(direct) || direct < 0 || direct > 1)
  )
    return value;
  const legacyFields = [
    'application',
    'sceneColorStrength',
    'directLightingStrength',
    'sampleCount',
    'resolutionScale',
    'thickness',
    'distanceExponent',
    'distanceFallOff',
  ];
  const legacy =
    oldRoute ||
    source.method === 'spiral-ssao' ||
    legacyFields.some((field) => Object.hasOwn(source, field));
  if (!legacy) return value;
  const settings = { ...source };
  for (const field of [...legacyFields, 'radius', 'bias', 'intensity']) delete settings[field];
  if (settings.method === 'spiral-ssao') settings.method = 'ssao';
  if (settings.quality === 'low') settings.quality = 25;
  if (settings.quality === 'medium') settings.quality = 50;
  if (settings.quality === 'high') settings.quality = 100;
  return settings;
}

/** Optional Engine shader publications may omit the AO family. */
export function hasScreenAoPrograms(
  pipeline: Pick<import('./record/render-context').PipelineState, 'perPassResources'> | null,
  depth: import('./record/render-context').RenderSystemInternals['depthPyramidShaders'],
): boolean {
  return (
    pipeline?.perPassResources?.ssaoScreenPipeline !== undefined &&
    depth !== undefined &&
    'seed' in depth
  );
}
