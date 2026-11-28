import type { CloudEdit, CloudMaterialMode } from './cloud-controls.ts';
import type { CloudParameterKey } from './parameter-labels.ts';

export const DAYTIME_MIN_ELEVATION = -4;
export const DAYTIME_MAX_ELEVATION = 180;
export const DAYTIME_DURATION_SECONDS = 120;
export const DAYTIME_DEFAULT_MATERIAL_MODE: CloudMaterialMode = 'sample-ue';

export const DAYTIME_SPEEDS = [0.5, 1, 2, 4] as const;
export type DaytimeSpeed = (typeof DAYTIME_SPEEDS)[number];

export const DAYTIME_STAGE_IDS = ['dawn', 'morning', 'noon', 'sunset'] as const;
export type DaytimeStageId = (typeof DAYTIME_STAGE_IDS)[number];

export const DAYTIME_DRIVEN_PARAMETER_KEYS = [
  'bottomMeters',
  'thicknessMeters',
  'windX',
  'windY',
  'windZ',
  'extinctionPerMeter',
  'layoutWeight',
  'maskWeight',
  'profileWeight',
  'bodyWeight',
  'erosionWeight',
  'coverageBias',
  'useDetail',
] as const satisfies readonly CloudParameterKey[];

export type DaytimeDrivenKey = (typeof DAYTIME_DRIVEN_PARAMETER_KEYS)[number];
export type DaytimeNumericKey = Exclude<DaytimeDrivenKey, 'useDetail'>;
export type DaytimeParameters = Readonly<
  Record<DaytimeNumericKey, number> & { readonly useDetail: boolean }
>;

export interface DaytimeStageAnchor {
  readonly id: DaytimeStageId;
  readonly label: string;
  readonly cloudType: string;
  readonly elevation: number;
}

export const DAYTIME_STAGE_ANCHORS: Readonly<Record<DaytimeStageId, DaytimeStageAnchor>> = Object.freeze({
  dawn: Object.freeze({ id: 'dawn', label: '黎明', cloudType: '薄片层云', elevation: -4 }),
  morning: Object.freeze({ id: 'morning', label: '上午', cloudType: '薄片层云', elevation: 18 }),
  noon: Object.freeze({ id: 'noon', label: '中午', cloudType: '层积云', elevation: 90 }),
  sunset: Object.freeze({ id: 'sunset', label: '落日', cloudType: '高空碎云', elevation: 170 }),
});

/** Elevation bounds for the three cloud regimes and their smooth transition bands. */
export const DAYTIME_TRANSITIONS = Object.freeze({
  morningEnd: 40,
  noonStart: 65,
  noonEnd: 125,
  sunsetStart: 150,
});

/**
 * Three-stage volumetric cloud parameter standards authored for the UE5 texture set
 * (`sample-ue`: T_CloudPattern, T_CloudMask, T_Profile_08, VT_PerlinWorley_Balanced).
 * Only parameters from "云层配置与创作" and "云密度与体积材质" are driven.
 */
export const DAYTIME_CLOUD_PROFILES = Object.freeze({
  /** Stage 1 (-4°..40°): Morning razor-thin layered stratus sheets with clear blue sky gaps. */
  morning: Object.freeze({
    bottomMeters: 2400,
    thicknessMeters: 1050,
    windX: -220,
    windY: 20,
    windZ: 240,
    extinctionPerMeter: 0.016,
    layoutWeight: 1,
    maskWeight: 0,
    profileWeight: 1,
    bodyWeight: 0.36,
    erosionWeight: 0.14,
    coverageBias: -0.055,
    useDetail: false,
  } satisfies DaytimeParameters),
  /** Stage 2 (65°..125°): Midday sculpted volumetric stratocumulus with convective boil. */
  noon: Object.freeze({
    bottomMeters: 1000,
    thicknessMeters: 7200,
    windX: -320,
    windY: 150,
    windZ: 480,
    extinctionPerMeter: 0.016,
    layoutWeight: 1,
    maskWeight: 0,
    profileWeight: 1,
    bodyWeight: 1,
    erosionWeight: 0.92,
    coverageBias: -0.13,
    useDetail: false,
  } satisfies DaytimeParameters),
  /** Stage 3 (150°..180°): Sunset high broken altocumulus with brisk upper-air flow. */
  sunset: Object.freeze({
    bottomMeters: 5000,
    thicknessMeters: 2100,
    windX: -560,
    windY: 60,
    windZ: 880,
    extinctionPerMeter: 0.0115,
    layoutWeight: 1,
    maskWeight: 0.85,
    profileWeight: 0.98,
    bodyWeight: 1,
    erosionWeight: 1,
    coverageBias: -0.2,
    useDetail: false,
  } satisfies DaytimeParameters),
});

const NUMERIC_KEYS = DAYTIME_DRIVEN_PARAMETER_KEYS.filter(
  (key): key is DaytimeNumericKey => key !== 'useDetail',
);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function blendProfiles(from: DaytimeParameters, to: DaytimeParameters, t: number): DaytimeParameters {
  const out: Record<string, number | boolean> = { useDetail: from.useDetail };
  for (const key of NUMERIC_KEYS) {
    out[key] = from[key] + (to[key] - from[key]) * t;
  }
  return out as DaytimeParameters;
}

export function clampDaytimeElevation(elevation: number): number {
  return clamp(elevation, DAYTIME_MIN_ELEVATION, DAYTIME_MAX_ELEVATION);
}

/** Deterministic continuous mapping from solar elevation (-4°..180°) to cloud parameters. */
export function evaluateDaytimeParameters(elevation: number): DaytimeParameters {
  const angle = clampDaytimeElevation(elevation);
  const { morningEnd, noonStart, noonEnd, sunsetStart } = DAYTIME_TRANSITIONS;
  if (angle <= morningEnd) return { ...DAYTIME_CLOUD_PROFILES.morning };
  if (angle < noonStart) {
    return blendProfiles(
      DAYTIME_CLOUD_PROFILES.morning,
      DAYTIME_CLOUD_PROFILES.noon,
      smoothstep(morningEnd, noonStart, angle),
    );
  }
  if (angle <= noonEnd) return { ...DAYTIME_CLOUD_PROFILES.noon };
  if (angle < sunsetStart) {
    return blendProfiles(
      DAYTIME_CLOUD_PROFILES.noon,
      DAYTIME_CLOUD_PROFILES.sunset,
      smoothstep(noonEnd, sunsetStart, angle),
    );
  }
  return { ...DAYTIME_CLOUD_PROFILES.sunset };
}

export interface DaytimeStageDescription {
  readonly id: DaytimeStageId;
  readonly label: string;
  readonly cloudType: string;
  readonly transitioning: boolean;
  readonly progress: number;
}

export function describeDaytimeStage(elevation: number): DaytimeStageDescription {
  const angle = clampDaytimeElevation(elevation);
  const progress =
    (angle - DAYTIME_MIN_ELEVATION) / (DAYTIME_MAX_ELEVATION - DAYTIME_MIN_ELEVATION);
  const { morningEnd, noonStart, noonEnd, sunsetStart } = DAYTIME_TRANSITIONS;
  if (angle < 0) {
    return { id: 'dawn', label: '黎明 · 薄片层云', cloudType: '薄片层云', transitioning: false, progress };
  }
  if (angle <= morningEnd) {
    return { id: 'morning', label: '上午 · 薄片层云', cloudType: '薄片层云', transitioning: false, progress };
  }
  if (angle < noonStart) {
    return { id: 'morning', label: '过渡 · 层云 → 层积云', cloudType: '层云 → 层积云', transitioning: true, progress };
  }
  if (angle <= noonEnd) {
    return { id: 'noon', label: '中午 · 层积云', cloudType: '层积云', transitioning: false, progress };
  }
  if (angle < sunsetStart) {
    return { id: 'noon', label: '过渡 · 层积云 → 高空碎云', cloudType: '层积云 → 高空碎云', transitioning: true, progress };
  }
  return { id: 'sunset', label: '落日 · 高空破碎晚霞云', cloudType: '高空破碎晚霞云', transitioning: false, progress };
}

const DAYTIME_END_EPSILON = 1e-6;

export function stepDaytimeElevation(
  currentElevation: number,
  dtSeconds: number,
  speed: DaytimeSpeed,
): { readonly elevation: number; readonly completed: boolean } {
  const start = clampDaytimeElevation(currentElevation);
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    return { elevation: start, completed: start >= DAYTIME_MAX_ELEVATION - DAYTIME_END_EPSILON };
  }
  const degreesPerSecond =
    ((DAYTIME_MAX_ELEVATION - DAYTIME_MIN_ELEVATION) / DAYTIME_DURATION_SECONDS) * speed;
  const next = start + degreesPerSecond * dtSeconds;
  if (next >= DAYTIME_MAX_ELEVATION - DAYTIME_END_EPSILON) {
    return { elevation: DAYTIME_MAX_ELEVATION, completed: true };
  }
  return { elevation: next, completed: false };
}

export function readDaytimeSpeed(value: unknown): DaytimeSpeed | undefined {
  return typeof value === 'number' && DAYTIME_SPEEDS.some(speed => speed === value)
    ? (value as DaytimeSpeed)
    : undefined;
}

export function readDaytimeStage(value: unknown): DaytimeStageAnchor | undefined {
  return typeof value === 'string' && Object.hasOwn(DAYTIME_STAGE_ANCHORS, value)
    ? DAYTIME_STAGE_ANCHORS[value as DaytimeStageId]
    : undefined;
}

export function touchesDaytimeDrivenParameter(edit: CloudEdit): boolean {
  return DAYTIME_DRIVEN_PARAMETER_KEYS.some(key => edit[key] !== undefined);
}

export interface DaytimeTransformState {
  readonly active: boolean;
  readonly playing: boolean;
  readonly completed: boolean;
  readonly speed: DaytimeSpeed;
  readonly elevation: number;
  readonly durationSeconds: number;
  readonly stage: DaytimeStageDescription;
}
