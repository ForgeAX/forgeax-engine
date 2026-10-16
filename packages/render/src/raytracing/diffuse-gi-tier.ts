import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type {
  StandardDiffuseGi,
  StandardGlobalSdfRegion,
  StandardIrradianceField,
  StandardProfile,
  StandardScreenProbes,
} from '../pipeline/standard-profile';
import { freezeDiffuseGi, validateDiffuseGi } from './irradiance-field-plan';
import type { RayReferenceError } from './scene';

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
        probeBudget: 64,
        hysteresis: 0.8,
        cardResolution: 16,
        cardBudget: 128,
        clipmapLevels: 2,
        resolution: 'half',
        radiosity: false,
      }),
    }),
    high: Object.freeze({
      field: Object.freeze({
        raysPerProbe: 64,
        probeBudget: 128,
        hysteresis: 0.7,
        cardResolution: 16,
        cardBudget: 256,
        clipmapLevels: 3,
        resolution: 'half',
        radiosity: true,
      }),
      probes: Object.freeze({
        downsample: 16,
        adaptiveFraction: 0.25,
        importance: 'brdf',
        screenTrace: Object.freeze({ maxSteps: 16, thickness: 0.02 }),
        filterPasses: 1,
        shortRangeAo: 0,
        maxFrames: 10,
      }),
    }),
    epic: Object.freeze({
      field: Object.freeze({
        raysPerProbe: 128,
        probeBudget: 256,
        hysteresis: 0.7,
        cardResolution: 16,
        cardBudget: 512,
        clipmapLevels: 4,
        resolution: 'full',
        radiosity: true,
      }),
      probes: Object.freeze({
        downsample: 8,
        adaptiveFraction: 0.5,
        importance: 'brdf',
        screenTrace: Object.freeze({ maxSteps: 32, thickness: 0.02 }),
        filterPasses: 2,
        shortRangeAo: 0,
        maxFrames: 10,
      }),
    }),
  } satisfies Record<DiffuseGiTier, DiffuseGiTierBudget>);

/** Render-profile fields one tier owns; spread over a Standard profile. */
export type DiffuseGiTierProfile = Pick<StandardProfile, 'renderPath' | 'pbr' | 'ibl' | 'ssao'> & {
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
  const raster = { renderPath: 'deferred', pbr: true } as const;
  if (tier === 'low')
    return ok(
      Object.freeze({
        tier,
        lane: 'direct-ibl-ssao',
        profile: Object.freeze({ ...raster, ibl: true, ssao: true }),
      }),
    );
  const gap = capabilityGap(caps);
  if (gap !== undefined)
    return ok(
      Object.freeze({
        tier,
        lane: 'direct-ibl',
        profile: Object.freeze({ ...raster, ibl: true, ssao: false }),
        fallback: Object.freeze({
          reason: gap,
          hint: 'Diffuse GI needs compute with storage buffers on a WebGPU-class backend; rendering direct + IBL.',
        }),
      }),
    );
  const budget = DIFFUSE_GI_TIER_BUDGETS[tier];
  const { cardResolution, cardBudget, clipmapLevels, ...fieldBudget } = budget.field as NonNullable<
    DiffuseGiTierBudget['field']
  >;
  const field: StandardIrradianceField = {
    ...fieldBudget,
    region: scene.region,
    probeSpacing: scene.probeSpacing,
    cards: {
      resolution: cardResolution,
      maxCaptureBytes: scene.maxCaptureBytes ?? 256 * 1024 * 1024,
      budget: cardBudget,
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
        ibl: false,
        ssao: false,
        diffuseGi: freezeDiffuseGi(diffuseGi),
      }),
    }),
  );
}

export function parseDiffuseGiTier(value: string | null | undefined): DiffuseGiTier | undefined {
  return DIFFUSE_GI_TIERS.find((tier) => tier === value);
}
