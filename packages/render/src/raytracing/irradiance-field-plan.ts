import { isValidAssetGuidString, ok, type Result } from '@forgeax/engine-types';
import type {
  StandardCardCapture,
  StandardDiffuseGi,
  StandardGlobalSdfRegion,
  StandardIrradianceField,
} from '../pipeline/standard-profile';
import { type GlobalSdfGrid, normalizeGlobalSdfGrid } from './global-sdf';
import { packGlobalSdfQuerySettings } from './global-sdf-query';
import { freezeLiteReflections, validateLiteReflections } from './reflections-plan';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import { validateSceneFieldBudget } from './scene-field-projection';
import { validateScreenProbes } from './screen-probe-plan';

/** Octahedral texels per probe axis for both irradiance and depth moments. One
 * 64-thread workgroup integrates one probe (UE uses 6x6 irradiance plus a
 * 14x14 occlusion border layout; a single 8x8 interior map is our deviation). */
export const IRRADIANCE_FIELD_OCT = 8;
export const IRRADIANCE_FIELD_TEXELS = IRRADIANCE_FIELD_OCT * IRRADIANCE_FIELD_OCT;
/** 4x4 octahedral prefilter of the 8x8 radiance level. */
export const IRRADIANCE_FIELD_MIP_TEXELS = (IRRADIANCE_FIELD_OCT / 2) ** 2;
/** Per probe vec4f texels: 8x8 irradiance D = E/pi (derived), 8x8 radiance L
 * (hysteresis authority), 4x4 radiance prefilter. Must match
 * `forgeax_ray::irradiance_field_sample` IRRADIANCE_FIELD_PROBE_STRIDE. */
export const IRRADIANCE_FIELD_PROBE_STRIDE =
  2 * IRRADIANCE_FIELD_TEXELS + IRRADIANCE_FIELD_MIP_TEXELS;
export const IRRADIANCE_FIELD_PROBE_BYTES = IRRADIANCE_FIELD_PROBE_STRIDE * 16;
/** Per probe: 64 x vec2f mean/mean^2 ray distance. */
export const IRRADIANCE_FIELD_DEPTH_BYTES = IRRADIANCE_FIELD_TEXELS * 8;
/** Per probe: updates, classification, f16 relocation offset (`IrradianceFieldProbeState`). */
export const IRRADIANCE_FIELD_META_BYTES = 16;
export const IRRADIANCE_FIELD_MAX_PROBES = 32768;
const IRRADIANCE_FIELD_MAX_LEVELS = 4;

export interface IrradianceFieldPlan {
  readonly grid: GlobalSdfGrid;
  readonly querySettings: Uint8Array;
  /** Cell (0,0,0) of every level; one region sample inside the composed border. */
  readonly origin: readonly [number, number, number];
  /** Level-0 probe spacing; level `l` spaces `spacing * 2^l`. */
  readonly spacing: number;
  /** Probes per axis of one level window. */
  readonly dimensions: readonly [number, number, number];
  /** Nested clipmap levels; 1 without a clipmap. */
  readonly levels: number;
  /** True when the windows follow the camera; false pins one window at the origin. */
  readonly follow: boolean;
  /** All levels: `levels * dimensions.x * dimensions.y * dimensions.z`. */
  readonly probeCount: number;
  readonly raysPerProbe: number;
  readonly probeBudget: number;
  /** Round-robin share of `probeBudget` per level (2^-l weights, at least one each). */
  readonly levelBudgets: readonly number[];
  readonly hysteresis: number;
  readonly cardResolution: number;
  readonly cardBudget: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** Pack asset GUID spelling (`@forgeax/engine-pack` guid). */
const unknownKey = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).find((key) => !keys.includes(key));

/** One structured rule for every Global SDF region consumer. */
export function validateGlobalSdfRegion(
  region: StandardGlobalSdfRegion,
  extraKeys: readonly string[] = [],
): Result<{ grid: GlobalSdfGrid; settings: Uint8Array }, RayReferenceError> {
  if (!isObject(region))
    return rayReferenceFailure('Global SDF region requires one configuration object');
  const extra = unknownKey(region, [
    'grid',
    'maxInstances',
    'maxFieldBytes',
    'maxSteps',
    'minStepFactor',
    ...extraKeys,
  ]);
  if (extra !== undefined)
    return rayReferenceFailure(`Global SDF region contains unsupported field '${extra}'`);
  const grid = normalizeGlobalSdfGrid(region.grid);
  if (!grid.ok) return grid;
  const settings = packGlobalSdfQuerySettings(grid.value, region);
  if (!settings.ok) return settings;
  const budget = validateSceneFieldBudget(region);
  if (!budget.ok) return budget;
  return ok({ grid: grid.value, settings: settings.value });
}

export function validateCardCapture(cards: StandardCardCapture): Result<void, RayReferenceError> {
  if (
    !isObject(cards) ||
    unknownKey(cards, ['resolution', 'maxCaptureBytes', 'budget']) !== undefined ||
    !Number.isInteger(cards.resolution) ||
    cards.resolution < 8 ||
    cards.resolution > 512 ||
    !Number.isSafeInteger(cards.maxCaptureBytes) ||
    cards.maxCaptureBytes < 1 ||
    cards.maxCaptureBytes > 256 * 1024 * 1024
  )
    return rayReferenceFailure(
      'Native Card capture requires 8..512 resolution and a positive capture budget up to 256 MiB',
    );
  if (!Number.isSafeInteger(cards.budget) || cards.budget < 1)
    return rayReferenceFailure('Native Card capture requires a positive per-frame tile budget');
  return ok(undefined);
}

/** Derive the probe lattice and budgets. Pure CPU; no device or scene access. */
export function planIrradianceField(
  field: StandardIrradianceField,
): Result<IrradianceFieldPlan, RayReferenceError> {
  if (!isObject(field)) return rayReferenceFailure('irradiance field requires one object');
  const extra = unknownKey(field, [
    'region',
    'probeSpacing',
    'raysPerProbe',
    'probeBudget',
    'hysteresis',
    'cards',
    'resolution',
    'radiosity',
    'clipmap',
  ]);
  if (extra !== undefined)
    return rayReferenceFailure(`irradiance field contains unsupported field '${extra}'`);
  const region = validateGlobalSdfRegion(field.region);
  if (!region.ok) return region;
  const cards = validateCardCapture(field.cards);
  if (!cards.ok) return cards;
  if (field.resolution !== 'full' && field.resolution !== 'half')
    return rayReferenceFailure("irradiance field resolution must be 'full' or 'half'");
  if (typeof field.radiosity !== 'boolean')
    return rayReferenceFailure('irradiance field radiosity must be boolean');
  const grid = region.value.grid;
  const spacing = Math.fround(field.probeSpacing);
  if (!Number.isFinite(spacing) || spacing < grid.spacing)
    return rayReferenceFailure(
      'irradiance field probe spacing must be finite and at least the Global SDF spacing',
    );
  if (!Number.isInteger(field.raysPerProbe) || field.raysPerProbe < 16 || field.raysPerProbe > 256)
    return rayReferenceFailure('irradiance field traces 16..256 rays per probe', true);
  if (!Number.isSafeInteger(field.probeBudget) || field.probeBudget < 1)
    return rayReferenceFailure('irradiance field requires a positive per-frame probe budget');
  if (typeof field.hysteresis !== 'number' || !(field.hysteresis >= 0 && field.hysteresis < 1))
    return rayReferenceFailure('irradiance field hysteresis must be in [0, 1)');
  const origin = grid.origin.map((v) => Math.fround(v + grid.spacing)) as [number, number, number];
  // Interior samples [1, n-2] keep one composed border for hit-normal differences.
  const clipmap = field.clipmap;
  if (
    clipmap !== undefined &&
    (!isObject(clipmap) ||
      unknownKey(clipmap, ['levels', 'dimensions']) !== undefined ||
      !Number.isInteger(clipmap.levels) ||
      clipmap.levels < 1 ||
      clipmap.levels > IRRADIANCE_FIELD_MAX_LEVELS ||
      !Array.isArray(clipmap.dimensions) ||
      clipmap.dimensions.length !== 3 ||
      clipmap.dimensions.some(
        (n: unknown) => !Number.isInteger(n) || Number(n) < 2 || Number(n) > 64,
      ))
  )
    return rayReferenceFailure(
      `irradiance field clipmap requires 1..${IRRADIANCE_FIELD_MAX_LEVELS} levels and 2..64 probes per axis`,
    );
  const levels = clipmap?.levels ?? 1;
  const dimensions =
    clipmap === undefined
      ? (grid.dimensions.map((n) => Math.floor(((n - 3) * grid.spacing) / spacing + 1e-6) + 1) as [
          number,
          number,
          number,
        ])
      : ([...clipmap.dimensions] as [number, number, number]);
  if (dimensions.some((n) => n < 2))
    return rayReferenceFailure(
      'irradiance field requires at least two probes per axis inside the Global SDF region',
    );
  const probeCount = levels * dimensions[0] * dimensions[1] * dimensions[2];
  if (probeCount > IRRADIANCE_FIELD_MAX_PROBES)
    return rayReferenceFailure(
      `irradiance field allows at most ${IRRADIANCE_FIELD_MAX_PROBES} probes`,
      true,
    );
  if (field.probeBudget < levels)
    return rayReferenceFailure('irradiance field probe budget must cover every clipmap level');
  const probeBudget = Math.min(field.probeBudget, probeCount);
  return ok({
    grid,
    querySettings: region.value.settings,
    origin,
    spacing,
    dimensions,
    levels,
    follow: clipmap !== undefined,
    probeCount,
    raysPerProbe: field.raysPerProbe,
    probeBudget,
    levelBudgets: splitProbeBudget(probeBudget, levels, probeCount / levels),
    hysteresis: field.hysteresis,
    cardResolution: field.cards.resolution,
    cardBudget: field.cards.budget,
  });
}

/**
 * Probe hysteresis per lattice sweep after a Card relight; the configured
 * value resumes after the last. Two quarter-history sweeps flush the stale
 * indirect light and the two half-history sweeps damp the noise they leave
 * before steady-state hysteresis returns (hello-gi light move: courtyard 90 %
 * in 59 frames, leak in 73, against none and 112 with `[0.25, 0.5]`).
 */
export const IRRADIANCE_FIELD_RELIGHT_SWEEPS: readonly number[] = Object.freeze([
  0.25, 0.25, 0.5, 0.5,
]);

/**
 * Frames per steady-state radiosity rotation. With static lights and scene the
 * Card direct light is cached; radiosity re-gathers the probe field into
 * `1 / period` of the tiles per frame (Lumen's radiosity fraction). For
 * `IRRADIANCE_FIELD_RELIGHT_SWEEPS.length` probe sweeps after any Card relight
 * (capture, light change or edit) every budgeted tile re-gathers instead.
 */
export const IRRADIANCE_FIELD_RADIOSITY_PERIOD = 4;

/**
 * Steady-state radiosity rotation in frames: `IRRADIANCE_FIELD_RADIOSITY_PERIOD`,
 * shortened so every tile re-gathers at least once per probe sweep and a Card
 * never lags the field it reads by more than the field lags its Cards.
 */
export function irradianceFieldRadiosityPeriod(
  plan: Pick<IrradianceFieldPlan, 'probeBudget' | 'probeCount'>,
): number {
  const framesPerSweep = Math.floor(plan.probeCount / Math.max(1, plan.probeBudget));
  return Math.max(1, Math.min(IRRADIANCE_FIELD_RADIOSITY_PERIOD, framesPerSweep));
}

/**
 * Probe hysteresis after a Card relight, from the number of probe updates
 * since it: sweep `i` uses
 * `min(hysteresis, IRRADIANCE_FIELD_RELIGHT_SWEEPS[i])`. Steady state is
 * unchanged. Each Card relight restarts the first sweep.
 */
export function irradianceFieldRelightHysteresis(
  plan: Pick<IrradianceFieldPlan, 'hysteresis' | 'probeCount'>,
  probesSinceDirect: number,
): number {
  const sweep = IRRADIANCE_FIELD_RELIGHT_SWEEPS[Math.floor(probesSinceDirect / plan.probeCount)];
  return sweep === undefined ? plan.hysteresis : Math.min(plan.hysteresis, sweep);
}

/** Level `l` gets a 2^-l share of the budget, at least one probe, at most one window. */
export function splitProbeBudget(budget: number, levels: number, perLevel: number): number[] {
  const total = 2 - 2 ** (1 - levels);
  const out = Array.from({ length: levels }, (_, l) =>
    Math.min(perLevel, Math.max(1, Math.floor((budget * 2 ** -l) / total))),
  );
  const rest = budget - out.reduce((n, v) => n + v, 0);
  out[0] = Math.max(1, Math.min(perLevel, (out[0] ?? 0) + rest));
  return out;
}

const EXACT_KEYS = [
  'gather',
  'maxBounces',
  'maxDistance',
  'environment',
  'seed',
  'reconstruction',
  'reflections',
];

/** Closed gather selector. A future lane adds one member and one branch here. */
export function validateDiffuseGi(gi: StandardDiffuseGi): Result<void, RayReferenceError> {
  if (!isObject(gi)) return rayReferenceFailure('Diffuse GI requires one configuration object');
  if (gi.gather === 'baked')
    return unknownKey(gi, ['gather', 'volume', 'resolution']) === undefined &&
      isValidAssetGuidString(gi.volume) &&
      (gi.resolution === 'full' || gi.resolution === 'half')
      ? ok(undefined)
      : rayReferenceFailure(
          "Baked GI requires one irradiance-volume asset GUID and resolution 'full' or 'half'",
        );
  const common =
    Number.isFinite(Math.fround(gi.maxDistance)) &&
    gi.maxDistance > 0 &&
    Array.isArray(gi.environment) &&
    gi.environment.length === 3 &&
    gi.environment.every(
      (v: unknown) => typeof v === 'number' && Number.isFinite(Math.fround(v)) && v >= 0,
    );
  switch (gi.gather) {
    case 'exact':
      if (
        !common ||
        unknownKey(gi, EXACT_KEYS) !== undefined ||
        !Number.isInteger(gi.maxBounces) ||
        (gi.reconstruction !== undefined &&
          !['spatial', 'temporal', 'combined'].includes(gi.reconstruction)) ||
        gi.maxBounces < 1 ||
        gi.maxBounces > 8 ||
        !Number.isInteger(gi.seed) ||
        gi.seed < 0 ||
        gi.seed > 0xffffffff
      )
        return rayReferenceFailure(
          'Diffuse GI requires 1..8 bounces, a positive f32 distance, a u32 seed and nonnegative linear RGB',
        );
      return validateLiteReflections(gi);
    case 'irradiance-field': {
      if (
        !common ||
        unknownKey(gi, ['gather', 'maxDistance', 'environment', 'field', 'reflections']) !==
          undefined
      )
        return rayReferenceFailure(
          'Irradiance-field GI requires a positive f32 distance, nonnegative linear RGB and one field',
        );
      const plan = planIrradianceField(gi.field);
      return plan.ok ? validateLiteReflections(gi) : plan;
    }
    case 'screen-probe': {
      if (
        !common ||
        unknownKey(gi, [
          'gather',
          'maxDistance',
          'environment',
          'probes',
          'field',
          'reflections',
        ]) !== undefined
      )
        return rayReferenceFailure(
          'Screen-probe GI requires a positive f32 distance, nonnegative linear RGB, probes and one fallback field',
        );
      const probes = validateScreenProbes(gi.probes);
      if (!probes.ok) return probes;
      const plan = planIrradianceField(gi.field);
      return plan.ok ? validateLiteReflections(gi) : plan;
    }
    default:
      return rayReferenceFailure(
        "Diffuse GI gather must be 'exact', 'irradiance-field', 'screen-probe' or 'baked'",
      );
  }
}

/** Deep-freeze one accepted profile so its JSON identity is stable. */
export function freezeDiffuseGi(gi: StandardDiffuseGi): StandardDiffuseGi {
  if (gi.gather === 'baked') return Object.freeze({ ...gi });
  const environment = Object.freeze([...gi.environment]) as readonly [number, number, number];
  const reflections =
    gi.reflections === undefined ? {} : { reflections: freezeLiteReflections(gi.reflections) };
  if (gi.gather === 'exact') return Object.freeze({ ...gi, environment, ...reflections });
  const { region, cards } = gi.field;
  const field = Object.freeze({
    ...gi.field,
    ...(gi.field.clipmap === undefined
      ? {}
      : {
          clipmap: Object.freeze({
            ...gi.field.clipmap,
            dimensions: Object.freeze([...gi.field.clipmap.dimensions]) as unknown as readonly [
              number,
              number,
              number,
            ],
          }),
        }),
    cards: Object.freeze({ ...cards }),
    region: Object.freeze({ ...region, grid: freezeGlobalSdfGrid(region.grid) }),
  });
  if (gi.gather === 'screen-probe')
    return Object.freeze({
      ...gi,
      environment,
      ...reflections,
      field,
      probes: Object.freeze({
        ...gi.probes,
        screenTrace: Object.freeze({ ...gi.probes.screenTrace }),
        ...(gi.probes.history === undefined
          ? {}
          : { history: Object.freeze({ ...gi.probes.history }) }),
      }),
    });
  return Object.freeze({ ...gi, environment, ...reflections, field });
}

export function freezeGlobalSdfGrid(grid: GlobalSdfGrid): GlobalSdfGrid {
  return Object.freeze({
    ...grid,
    origin: Object.freeze([...grid.origin]) as unknown as GlobalSdfGrid['origin'],
    dimensions: Object.freeze([...grid.dimensions]) as unknown as GlobalSdfGrid['dimensions'],
  });
}
