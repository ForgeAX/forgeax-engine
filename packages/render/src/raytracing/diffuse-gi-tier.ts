import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type {
  StandardCardCapture,
  StandardDiffuseGi,
  StandardGlobalSdfRegion,
  StandardIrradianceField,
  StandardProfile,
  StandardScreenProbes,
} from '../pipeline/standard-profile';
import { freezeDiffuseGi, validateDiffuseGi } from './irradiance-field-plan';
import type { RayReferenceError } from './scene';
import { SCREEN_PROBE_DEFAULTS } from './screen-probe-plan';

/** Closed diffuse GI quality ladder (UE sg.GlobalIlluminationQuality 0..3). */
export type DiffuseGiTier = 'low' | 'medium' | 'high' | 'epic';
export const DIFFUSE_GI_TIERS: readonly DiffuseGiTier[] = Object.freeze([
  'low',
  'medium',
  'high',
  'epic',
]);

/** What one tier resolves to after capabilities: a GI gather lane or a raster fallback. */
export type DiffuseGiTierLane =
  | 'direct-ibl-ssao'
  | 'direct-ibl'
  | 'irradiance-field'
  | 'screen-probe';

/** Why a GI tier could not run its lane; data, never an exception. */
export type DiffuseGiTierFallbackReason =
  | 'compute-unavailable'
  | 'storage-buffer-unavailable'
  | 'webgl2-backend';

/** Scene framing owned by the caller; tiers own only the per-frame budgets. */
export interface DiffuseGiTierScene {
  readonly maxDistance: number;
  readonly environment: readonly [number, number, number];
  readonly region: StandardGlobalSdfRegion;
  /** Probe lattice spacing, at least the region spacing. */
  readonly probeSpacing: number;
  /**
   * Card capture byte ceiling, a cap rather than an allocation; defaults to 256 MiB
   * (Sponza needs about 43 MB). On either world traversal a scene beyond the
   * ceiling keeps the highest view-priority Cards resident and streams the rest
   * (`diffuseGi.residency`) instead of failing; only invalid configs reject.
   */
  readonly maxCaptureBytes?: number;
  /** Authored per-Card capture resolution, when the assets require finer charts. */
  readonly cardResolution?: number;
  /** Camera-following probe window (probes per axis per level); absent keeps one fixed
   * lattice. The tier owns the level count and its `probeBudget` splits over levels. */
  readonly clipmapDimensions?: readonly [number, number, number];
}

/** Fixed per-tier budgets; `field` is omitted for `low`, `probes` for non screen-probe tiers. */
export interface DiffuseGiTierBudget {
  readonly field?: Omit<
    StandardIrradianceField,
    'region' | 'probeSpacing' | 'cards' | 'clipmap'
  > & {
    readonly cardResolution: number;
    readonly cardBudget: number;
    readonly cardRadiosity: NonNullable<StandardCardCapture['radiosity']>;
    /** Clipmap levels when the scene opts into a camera-following window. */
    readonly clipmapLevels: number;
  };
  readonly probes?: StandardScreenProbes;
}

export const DIFFUSE_GI_TIER_BUDGETS: Readonly<Record<DiffuseGiTier, DiffuseGiTierBudget>> =
  Object.freeze({
    low: Object.freeze({}),
    medium: Object.freeze({
      field: Object.freeze({
        raysPerProbe: 32,
        probeBudget: 100,
        hysteresis: 0.8,
        cardResolution: 16,
        cardBudget: 128,
        cardRadiosity: Object.freeze({
          probeSpacing: 4,
          hemisphereResolution: 3,
          updateFactor: 128,
        }),
        clipmapLevels: 2,
        resolution: 'half',
        radiosity: true,
      }),
    }),
    high: Object.freeze({
      field: Object.freeze({
        raysPerProbe: 64,
        probeBudget: 100,
        hysteresis: 0.7,
        cardResolution: 16,
        cardBudget: 256,
        cardRadiosity: Object.freeze({
          probeSpacing: 8,
          hemisphereResolution: 3,
          updateFactor: 128,
        }),
        clipmapLevels: 3,
        resolution: 'half',
        radiosity: true,
      }),
      probes: Object.freeze({
        ...SCREEN_PROBE_DEFAULTS,
        downsample: 32,
        adaptiveCandidates: 16,
        irradiance: 'probe-octahedral',
        integration: 'screen-space',
        interpolation: 'stochastic',
        shortRangeAo: 0.5,
        shortRangeAoMode: 'half-scalar',
      }),
    }),
    epic: Object.freeze({
      field: Object.freeze({
        raysPerProbe: 128,
        probeBudget: 150,
        hysteresis: 0.7,
        cardResolution: 16,
        cardBudget: 512,
        cardRadiosity: Object.freeze({
          probeSpacing: 4,
          hemisphereResolution: 4,
          updateFactor: 64,
        }),
        clipmapLevels: 4,
        resolution: 'full',
        radiosity: true,
      }),
      probes: Object.freeze({
        ...SCREEN_PROBE_DEFAULTS,
        adaptiveCandidates: 8,
        irradiance: 'probe-sh3',
        integration: 'screen-space',
        shortRangeAo: 0.5,
        shortRangeAoMode: 'full-bent',
      }),
    }),
  } satisfies Record<DiffuseGiTier, DiffuseGiTierBudget>);

/** Render-profile fields one tier owns; spread over a Standard profile. */
export type DiffuseGiTierProfile = Pick<
  StandardProfile,
  'renderPath' | 'pbr' | 'ibl' | 'ambientOcclusion'
> & {
  readonly diffuseGi?: StandardDiffuseGi;
};

export interface DiffuseGiTierResolution {
  readonly tier: DiffuseGiTier;
  readonly lane: DiffuseGiTierLane;
  readonly profile: DiffuseGiTierProfile;
  /** Present only when capabilities demoted a GI tier to direct + IBL. */
  readonly fallback?: { readonly reason: DiffuseGiTierFallbackReason; readonly hint: string };
}

type DiffuseGiTierCaps = Pick<RhiCaps, 'compute' | 'storageBuffer' | 'backendKind'>;

function capabilityGap(caps: DiffuseGiTierCaps): DiffuseGiTierFallbackReason | undefined {
  if (caps.backendKind === 'wgpu-webgl2') return 'webgl2-backend';
  if (!caps.compute) return 'compute-unavailable';
  if (!caps.storageBuffer) return 'storage-buffer-unavailable';
  return undefined;
}

/**
 * Resolves one quality tier against device capabilities. `low` is intentional
 * GI-off (IBL + SSAO); a GI tier on a device without compute storage demotes to
 * direct + IBL and reports the reason. The emitted `diffuseGi` is validated and frozen.
 */
export function resolveDiffuseGiTier(
  tier: DiffuseGiTier,
  scene: DiffuseGiTierScene,
  caps: DiffuseGiTierCaps,
): Result<DiffuseGiTierResolution, RayReferenceError> {
  const raster = { renderPath: 'deferred', pbr: true, ibl: true } as const;
  if (tier === 'low')
    return ok(
      Object.freeze({
        tier,
        lane: 'direct-ibl-ssao',
        profile: Object.freeze({ ...raster, ambientOcclusion: { enabled: true } }),
      }),
    );
  const gap = capabilityGap(caps);
  if (gap !== undefined)
    return ok(
      Object.freeze({
        tier,
        lane: 'direct-ibl',
        profile: Object.freeze({ ...raster, ambientOcclusion: { enabled: false } }),
        fallback: Object.freeze({
          reason: gap,
          hint: 'Diffuse GI needs compute with storage buffers on a WebGPU-class backend; rendering direct + IBL.',
        }),
      }),
    );
  const budget = DIFFUSE_GI_TIER_BUDGETS[tier];
  const { cardResolution, cardBudget, cardRadiosity, clipmapLevels, ...fieldBudget } =
    budget.field as NonNullable<DiffuseGiTierBudget['field']>;
  const field: StandardIrradianceField = {
    ...fieldBudget,
    region: scene.region,
    probeSpacing: scene.probeSpacing,
    cards: {
      resolution: scene.cardResolution ?? cardResolution,
      maxCaptureBytes: scene.maxCaptureBytes ?? 256 * 1024 * 1024,
      budget: cardBudget,
      radiosity: cardRadiosity,
    },
    ...(scene.clipmapDimensions === undefined
      ? {}
      : { clipmap: { levels: clipmapLevels, dimensions: scene.clipmapDimensions } }),
  };
  const common = { maxDistance: scene.maxDistance, environment: scene.environment };
  const diffuseGi: StandardDiffuseGi =
    budget.probes === undefined
      ? { gather: 'irradiance-field', ...common, field }
      : { gather: 'screen-probe', ...common, field, probes: budget.probes };
  const valid = validateDiffuseGi(diffuseGi);
  if (!valid.ok) return valid;
  return ok(
    Object.freeze({
      tier,
      lane: diffuseGi.gather as 'irradiance-field' | 'screen-probe',
      profile: Object.freeze({
        ...raster,
        ambientOcclusion: { enabled: false },
        diffuseGi: freezeDiffuseGi(diffuseGi),
      }),
    }),
  );
}

export function parseDiffuseGiTier(value: string | null | undefined): DiffuseGiTier | undefined {
  return DIFFUSE_GI_TIERS.find((tier) => tier === value);
}
