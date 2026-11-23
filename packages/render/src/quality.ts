import type { ExtractedCloudLayer } from './cloud/extract';
import { assertTextureMipSkip } from './device/texture-mip-skip';
import { DEFAULT_STANDARD_PROFILE, resolveVolumetricFogProfile } from './pipeline/standard-profile';
import type { RenderProfile } from './render-contract';
import type { LightRoster } from './render-system-extract';
import type { SsaoParameterConfig } from './ssao-config';

/** Appearance and topology requirements; work budgets belong to quality groups. */
export const RENDERING_REQUIREMENT_KEYS = [
  'renderPath',
  'pbr',
  'ibl',
  'ambientOcclusion',
  'lightCount',
  'visibleSurface',
  'diffuseGi',
  'probePlacement',
  'gpuOcclusion',
  'featureReadOnlyDepthBatching',
] as const;
export type RenderingRequirements = Partial<
  Pick<RenderProfile, Exclude<(typeof RENDERING_REQUIREMENT_KEYS)[number], 'ambientOcclusion'>>
> & {
  readonly ambientOcclusion?: (SsaoParameterConfig & { readonly enabled?: boolean }) | undefined;
};

export function renderingRequirementsOf(value: RenderingRequirements): RenderingRequirements {
  return Object.fromEntries(
    RENDERING_REQUIREMENT_KEYS.filter((key) => value[key] !== undefined).map((key) => [
      key,
      value[key],
    ]),
  );
}

export function renderProfileForRequirements(requirements: RenderingRequirements): RenderProfile {
  const { ambientOcclusion, ...selected } = renderingRequirementsOf(requirements);
  return {
    ...DEFAULT_STANDARD_PROFILE,
    ...selected,
    ambientOcclusion:
      ambientOcclusion === undefined
        ? selected.diffuseGi === undefined
          ? DEFAULT_STANDARD_PROFILE.ambientOcclusion
          : { enabled: false }
        : {
            ...ambientOcclusion,
            enabled: ambientOcclusion.enabled === undefined ? true : ambientOcclusion.enabled,
          },
  };
}

export type RenderQualityLevel = 'low' | 'medium' | 'high';
export interface RenderQualityGroups {
  readonly resolution: RenderQualityLevel;
  readonly shadows: RenderQualityLevel;
  readonly ambientOcclusion: RenderQualityLevel;
  readonly reflections: RenderQualityLevel;
  readonly globalIllumination: RenderQualityLevel;
  readonly volumetrics: RenderQualityLevel;
  readonly textures: RenderQualityLevel;
  readonly shading: RenderQualityLevel;
}

/** Concrete, immutable budgets consumed by extraction, graph and shader owners. */
export interface RenderQualityBudgets {
  readonly resolutionScale: number;
  readonly shadowMapSize: number;
  readonly shadowCascades: number;
  readonly ambientOcclusion: {
    readonly quality: RenderQualityLevel;
    readonly resolutionScale: number;
  };
  readonly ssr: {
    readonly quality?: RenderQualityLevel;
    readonly resolutionScale: 0.5 | 1;
    readonly hizIterations: number;
    readonly linearIterations: number;
    readonly refineSteps: number;
  };
  readonly cloudSampleScale: number;
  readonly cloudShadowSamples: number;
}

/** Explicit project/device ceilings, composed with tier budgets using the stricter value. */
export type RenderQualityLimits = Partial<
  Omit<RenderQualityBudgets, 'ambientOcclusion' | 'ssr'>
> & {
  readonly ambientOcclusion?: Partial<RenderQualityBudgets['ambientOcclusion']>;
  readonly ssr?: Partial<RenderQualityBudgets['ssr']>;
  /** Minimum mip skip. Larger values retain fewer eligible GPU mip levels. */
  readonly textureMipSkip?: number;
};

const levelIndex = (level: RenderQualityLevel) => ['low', 'medium', 'high'].indexOf(level);

export function resolveRenderQualityBudgets(
  groups: RenderQualityGroups,
  limits?: RenderQualityLimits,
): RenderQualityBudgets {
  const resolution = levelIndex(groups.resolution);
  const shadow = levelIndex(groups.shadows);
  const reflection = levelIndex(groups.reflections);
  const volume = levelIndex(groups.volumetrics);
  const budget: RenderQualityBudgets = Object.freeze({
    resolutionScale: [0.5, 0.75, 1][resolution] ?? 1,
    shadowMapSize: [512, 1024, 0][shadow] ?? 0,
    shadowCascades: [2, 3, 4][shadow] ?? 4,
    ambientOcclusion: Object.freeze({
      quality: groups.ambientOcclusion,
      resolutionScale: groups.ambientOcclusion === 'high' ? 1 : 0.5,
    }),
    ssr: Object.freeze({
      quality: groups.reflections,
      resolutionScale: reflection === 2 ? (1 as const) : (0.5 as const),
      hizIterations: [16, 32, 64][reflection] ?? 64,
      linearIterations: [256, 512, 1024][reflection] ?? 1024,
      refineSteps: [3, 4, 5][reflection] ?? 5,
    }),
    cloudSampleScale: [0.5, 0.75, 1][volume] ?? 1,
    cloudShadowSamples: [4, 8, 0][volume] ?? 0,
  });
  if (limits === undefined) return budget;
  const failure = validateRenderQualityLimits(limits);
  if (failure !== undefined) throw new RangeError(failure);
  const bound = (value: number, limit: number | undefined) =>
    limit === undefined ? value : Math.min(value, limit);
  const shadowBound = (value: number, limit: number | undefined) =>
    limit === undefined || limit === 0 ? value : value === 0 ? limit : Math.min(value, limit);
  return Object.freeze({
    resolutionScale: bound(budget.resolutionScale, limits.resolutionScale),
    shadowMapSize: shadowBound(budget.shadowMapSize, limits.shadowMapSize),
    shadowCascades: bound(budget.shadowCascades, limits.shadowCascades),
    ambientOcclusion: Object.freeze({
      quality:
        limits.ambientOcclusion?.quality !== undefined &&
        levelIndex(limits.ambientOcclusion.quality) < levelIndex(budget.ambientOcclusion.quality)
          ? limits.ambientOcclusion.quality
          : budget.ambientOcclusion.quality,
      resolutionScale: bound(
        budget.ambientOcclusion.resolutionScale,
        limits.ambientOcclusion?.resolutionScale,
      ),
    }),
    ssr: Object.freeze({
      quality:
        limits.ssr?.quality !== undefined && levelIndex(limits.ssr.quality) < reflection
          ? limits.ssr.quality
          : groups.reflections,
      resolutionScale: bound(budget.ssr.resolutionScale, limits.ssr?.resolutionScale) as 0.5 | 1,
      hizIterations: bound(budget.ssr.hizIterations, limits.ssr?.hizIterations),
      linearIterations: bound(budget.ssr.linearIterations, limits.ssr?.linearIterations),
      refineSteps: bound(budget.ssr.refineSteps, limits.ssr?.refineSteps),
    }),
    cloudSampleScale: bound(budget.cloudSampleScale, limits.cloudSampleScale),
    cloudShadowSamples: shadowBound(budget.cloudShadowSamples, limits.cloudShadowSamples),
  });
}

/** Preserve authored AO appearance and algorithm; only bound its declared work. */
export function applyAmbientOcclusionQuality(
  authored: SsaoParameterConfig,
  budget: RenderQualityBudgets['ambientOcclusion'] | undefined,
): SsaoParameterConfig {
  if (budget === undefined) return authored;
  const ceiling = { low: 25, medium: 55, high: 100 }[budget.quality];
  return {
    ...authored,
    maxQuality: Math.min(authored.maxQuality ?? 100, ceiling),
    ...(authored.method === 'gtao' && budget.resolutionScale <= 0.5
      ? { gtao: { ...authored.gtao, downsample: true } }
      : {}),
  };
}

/** The native profile is derived from current author inputs, never the preceding tier. */
export function renderProfileForQuality(
  authored: RenderProfile | undefined,
  groups: RenderQualityGroups,
  limits?: RenderQualityLimits,
): RenderProfile {
  const source = authored ?? DEFAULT_STANDARD_PROFILE;
  const quality = resolveRenderQualityBudgets(groups, limits);
  const fog = resolveVolumetricFogProfile(source);
  const gi = source.diffuseGi;
  return {
    ...source,
    quality,
    ambientOcclusion: source.ambientOcclusion.enabled
      ? {
          ...applyAmbientOcclusionQuality(source.ambientOcclusion, quality.ambientOcclusion),
          enabled: true,
        }
      : source.ambientOcclusion,
    subsurfaceQuality:
      source.subsurfaceQuality === 'low' || groups.shading === 'low' ? 'low' : 'high',
    volumetricFog: {
      quality: fog.quality === 'low' || groups.volumetrics === 'low' ? 'low' : 'high',
      depth: groups.volumetrics === 'high' ? fog.depth : 48,
      tileSize: fog.tileSize === 16 || groups.volumetrics === 'low' ? 16 : 4,
    },
    ...(gi === undefined ? {} : { diffuseGi: resolveGiQuality(gi, groups.globalIllumination) }),
  };
}

function resolveGiQuality(
  gi: NonNullable<RenderProfile['diffuseGi']>,
  level: RenderQualityLevel,
): typeof gi {
  if (level === 'high' || gi.gather === 'exact') return gi;
  if (gi.gather === 'baked') return { ...gi, resolution: 'half' };
  const field = {
    ...gi.field,
    resolution: 'half' as const,
    raysPerProbe: Math.min(gi.field.raysPerProbe, level === 'low' ? 16 : 32),
    probeBudget: Math.min(gi.field.probeBudget, level === 'low' ? 4 : 16),
  };
  return gi.gather === 'screen-probe'
    ? {
        ...gi,
        field,
        probes: {
          ...gi.probes,
          downsample: Math.max(gi.probes.downsample, level === 'low' ? 32 : 16) as 16 | 32,
        },
      }
    : { ...gi, field };
}

export function textureMipSkipForQuality(
  level: RenderQualityLevel,
  limits?: RenderQualityLimits,
): number {
  return Math.max(level === 'low' ? 2 : level === 'medium' ? 1 : 0, limits?.textureMipSkip ?? 0);
}

/** Projection precedes cascade fitting and resource allocation; source facts stay untouched. */
export function lightsForQuality(
  source: LightRoster,
  budget: RenderQualityBudgets | undefined,
): LightRoster {
  if (budget === undefined || (budget.shadowMapSize === 0 && budget.shadowCascades >= 4))
    return source;
  const cap = (size: number) =>
    budget.shadowMapSize === 0 ? size : Math.min(size, budget.shadowMapSize);
  return {
    ...source,
    directionalCsmConfig:
      source.directionalCsmConfig === undefined
        ? undefined
        : {
            ...source.directionalCsmConfig,
            mapSize: cap(source.directionalCsmConfig.mapSize),
            cascadeCount: Math.min(source.directionalCsmConfig.cascadeCount, budget.shadowCascades),
          },
    spot: source.spot.map((light) => ({ ...light, mapSize: cap(light.mapSize) })),
    pointShadow: source.pointShadow.map((light) => ({ ...light, mapSize: cap(light.mapSize) })),
  };
}

/** Both cooked programs and sampled clouds consume the same view and shadow limits. */
export function cloudForQuality(
  layer: ExtractedCloudLayer | undefined,
  budget: RenderQualityBudgets | undefined,
): ExtractedCloudLayer | undefined {
  if (
    layer === undefined ||
    budget === undefined ||
    (budget.cloudShadowSamples === 0 && budget.cloudSampleScale === 1)
  )
    return layer;
  const samples = (value: number) =>
    budget.cloudShadowSamples === 0 ? value : Math.min(value, budget.cloudShadowSamples);
  return {
    ...layer,
    ...(layer.status === 'analytic'
      ? {}
      : { viewSampleCountScale: Math.min(layer.viewSampleCountScale, budget.cloudSampleScale) }),
    ...(layer.lighting === undefined
      ? {}
      : {
          lighting: {
            ...layer.lighting,
            shadow: [
              layer.lighting.shadow[0],
              samples(layer.lighting.shadow[1]),
              layer.lighting.shadow[2],
            ] as const,
          },
        }),
    ...(layer.shadowSettings === undefined
      ? {}
      : {
          shadowSettings: {
            ...layer.shadowSettings,
            mapSamples: samples(layer.shadowSettings.mapSamples),
          },
        }),
    ...(layer.shadowMap === undefined
      ? {}
      : { shadowMap: { ...layer.shadowMap, mapSamples: samples(layer.shadowMap.mapSamples) } }),
  };
}

/** Reject malformed native budget data before any graph or resource consumes it. */
export function validateRenderQualityBudgets(
  value: RenderQualityBudgets | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || !value.ambientOcclusion || !value.ssr)
    return 'Render quality requires complete typed budgets';
  const keys = [
    'resolutionScale',
    'shadowMapSize',
    'shadowCascades',
    'ambientOcclusion',
    'ssr',
    'cloudSampleScale',
    'cloudShadowSamples',
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)))
    return 'Render quality contains an unknown budget';
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const integer = (n: number, min: number, max: number) =>
    Number.isInteger(n) && n >= min && n <= max;
  if (
    !positive(value.resolutionScale) ||
    value.resolutionScale > 1 ||
    !integer(value.shadowMapSize, 0, 16384) ||
    !integer(value.shadowCascades, 1, 4)
  )
    return 'Render quality has invalid resolution or shadow budgets';
  return validateSamplingBudgets(value);
}

function validateSamplingBudgets(value: RenderQualityBudgets): string | undefined {
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const integer = (n: number, min: number, max: number) =>
    Number.isInteger(n) && n >= min && n <= max;
  if (
    !['low', 'medium', 'high'].includes(value.ambientOcclusion.quality) ||
    !positive(value.ambientOcclusion.resolutionScale) ||
    value.ambientOcclusion.resolutionScale > 1
  )
    return 'Render quality has invalid AO budgets';
  if (
    (value.ssr.quality !== undefined && !['low', 'medium', 'high'].includes(value.ssr.quality)) ||
    ![0.5, 1].includes(value.ssr.resolutionScale) ||
    !integer(value.ssr.hizIterations, 1, 64) ||
    !integer(value.ssr.linearIterations, 1, 1024) ||
    !integer(value.ssr.refineSteps, 1, 5)
  )
    return 'Render quality has invalid SSR budgets';
  if (
    !positive(value.cloudSampleScale) ||
    value.cloudSampleScale > 1 ||
    !integer(value.cloudShadowSamples, 0, 64)
  )
    return 'Render quality has invalid cloud budgets';
  return undefined;
}

export function validateRenderQualityLimits(limits: RenderQualityLimits): string | undefined {
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits))
    return 'Render quality limits must be data';
  const { textureMipSkip, ...budgets } = limits;
  if (textureMipSkip !== undefined) {
    try {
      assertTextureMipSkip(textureMipSkip);
    } catch {
      return 'Render quality textureMipSkip is invalid';
    }
  }
  const defaults = resolveRenderQualityBudgets({
    resolution: 'high',
    shadows: 'high',
    ambientOcclusion: 'high',
    reflections: 'high',
    globalIllumination: 'high',
    volumetrics: 'high',
    textures: 'high',
    shading: 'high',
  });
  if (
    limits.ambientOcclusion !== undefined &&
    (typeof limits.ambientOcclusion !== 'object' ||
      limits.ambientOcclusion === null ||
      Object.keys(limits.ambientOcclusion).some(
        (key) => !['quality', 'resolutionScale'].includes(key),
      ))
  )
    return 'Render quality AO limits contain unsupported fields';
  if (
    limits.ssr !== undefined &&
    (typeof limits.ssr !== 'object' ||
      limits.ssr === null ||
      Object.keys(limits.ssr).some(
        (key) =>
          ![
            'quality',
            'resolutionScale',
            'hizIterations',
            'linearIterations',
            'refineSteps',
          ].includes(key),
      ))
  )
    return 'Render quality SSR limits contain unsupported fields';
  return validateRenderQualityBudgets({
    ...defaults,
    ...budgets,
    ambientOcclusion: { ...defaults.ambientOcclusion, ...limits.ambientOcclusion },
    ssr: { ...defaults.ssr, ...limits.ssr },
  });
}
