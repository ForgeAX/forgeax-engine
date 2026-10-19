import { ok, type Result } from '@forgeax/engine-types';
import type { StandardScreenProbes } from '../pipeline/standard-profile';
import { type RayReferenceError, rayReferenceFailure } from './scene';

/** Octahedral radiance texels per probe edge (UE ScreenProbeTracingOctahedronResolution). */
const SCREEN_PROBE_OCT = 8;
export const SCREEN_PROBE_TEXELS = SCREEN_PROBE_OCT * SCREEN_PROBE_OCT;
/** Probe record: world position + view distance, normal + state. */
export const SCREEN_PROBE_RECORD_BYTES = 32;
/** Directional RGB/support (or history age), closest resolved hit, and WGSL padding. */
export const SCREEN_PROBE_RADIANCE_BYTES = 32;
/** Retained geometry and directional transport records with effective history ages. */
export const SCREEN_PROBE_HISTORY_BYTES =
  SCREEN_PROBE_RECORD_BYTES + SCREEN_PROBE_TEXELS * SCREEN_PROBE_RADIANCE_BYTES;
/** Adaptive slots per uniform tile: one per half-resolution sub-tile. */
export const SCREEN_PROBE_ADAPTIVE_SLOTS = 4;
export const SCREEN_PROBE_FRAME_BYTES = 176;
/** Per-pixel history metadata: view distance, encoded normal, sample count, flags. */
export const SCREEN_PROBE_META_BYTES = 16;

/** Ray status written by the screen trace and consumed by later stages. */
export const ScreenProbeRayStatus = {
  /** Screen hit with history radiance, or a world hit/miss with final radiance. */
  resolved: 0,
  /** Screen march found nothing usable; the world trace owns it next. */
  world: 1,
  /** No admissible trace; the irradiance field supplies the direction. */
  fallback: 2,
  /** Culled by importance sampling; the texel is filled from the field. */
  culled: 3,
  /** Required scene geometry is absent; cache reconstruction cannot resolve it. */
  incomplete: 4,
} as const;

export const SCREEN_PROBE_DEFAULTS: StandardScreenProbes = Object.freeze({
  downsample: 16,
  adaptiveFraction: 0.5,
  importance: 'brdf',
  screenTrace: Object.freeze({ maxSteps: 32, thickness: 0.02 }),
  filterPasses: 2,
  shortRangeAo: 0.5,
  maxFrames: 10,
}) as StandardScreenProbes;

const KEYS = [
  'downsample',
  'adaptiveFraction',
  'importance',
  'screenTrace',
  'filterPasses',
  'shortRangeAo',
  'maxFrames',
  'history',
];

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(Math.fround(value));

export function validateScreenProbes(
  probes: StandardScreenProbes,
): Result<void, RayReferenceError> {
  if (typeof probes !== 'object' || probes === null || Array.isArray(probes))
    return rayReferenceFailure('screen probes require one configuration object');
  const record = probes as unknown as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !KEYS.includes(key));
  const history = probes.history;
  const historyValid =
    history === undefined ||
    (typeof history === 'object' &&
      history !== null &&
      !Array.isArray(history) &&
      Object.entries(history).every(
        ([key, value]) => ['probe', 'pixel', 'screen'].includes(key) && typeof value === 'boolean',
      ));
  const trace = probes.screenTrace as unknown;
  const traceValid =
    typeof trace === 'object' &&
    trace !== null &&
    Object.keys(trace).every((key) => key === 'maxSteps' || key === 'thickness') &&
    Number.isInteger(probes.screenTrace.maxSteps) &&
    probes.screenTrace.maxSteps >= 0 &&
    probes.screenTrace.maxSteps <= 128 &&
    finite(probes.screenTrace.thickness) &&
    probes.screenTrace.thickness > 0 &&
    probes.screenTrace.thickness <= 1;
  if (
    extra !== undefined ||
    ![4, 8, 16, 32].includes(probes.downsample) ||
    !finite(probes.adaptiveFraction) ||
    probes.adaptiveFraction < 0 ||
    probes.adaptiveFraction > 1 ||
    (probes.importance !== 'uniform' && probes.importance !== 'brdf') ||
    !traceValid ||
    !historyValid ||
    !Number.isInteger(probes.filterPasses) ||
    probes.filterPasses < 0 ||
    probes.filterPasses > 4 ||
    !finite(probes.shortRangeAo) ||
    probes.shortRangeAo < 0 ||
    !Number.isInteger(probes.maxFrames) ||
    probes.maxFrames < 1 ||
    probes.maxFrames > 64
  )
    return rayReferenceFailure(
      `screen probes require downsample 4|8|16|32, adaptiveFraction in [0,1], uniform|brdf importance, 0..128 screen steps with thickness in (0,1], 0..4 filter passes, a nonnegative AO radius and 1..64 history frames with optional boolean probe/pixel/screen history controls${extra === undefined ? '' : `; unknown key ${extra}`}`,
    );
  return ok(undefined);
}

/** Per-extent probe layout. Uniform probes own one tile each; adaptive probes
 * fill a fixed-capacity tail and are referenced from their tile's sub-slots. */
export interface ScreenProbeLayout {
  readonly width: number;
  readonly height: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly uniformCount: number;
  readonly adaptiveCapacity: number;
  readonly probeCount: number;
}

export function planScreenProbeLayout(
  probes: StandardScreenProbes,
  width: number,
  height: number,
): ScreenProbeLayout {
  const tilesX = Math.ceil(width / probes.downsample);
  const tilesY = Math.ceil(height / probes.downsample);
  const uniformCount = tilesX * tilesY;
  const adaptiveCapacity = Math.min(
    uniformCount * SCREEN_PROBE_ADAPTIVE_SLOTS,
    Math.floor(uniformCount * probes.adaptiveFraction),
  );
  return {
    width,
    height,
    tilesX,
    tilesY,
    uniformCount,
    adaptiveCapacity,
    probeCount: uniformCount + adaptiveCapacity,
  };
}

export interface ScreenProbeFrame {
  readonly layout: ScreenProbeLayout;
  readonly downsample: number;
  readonly frameIndex: number;
  readonly importance: 'uniform' | 'brdf';
  readonly screenSteps: number;
  readonly thickness: number;
  readonly environment: readonly [number, number, number];
  readonly maxDistance: number;
  readonly shortRangeAo: number;
  readonly maxFrames: number;
  /** Previous-frame scene radiance exists and matches this extent. */
  readonly sceneHistory: boolean;
  /** Per-pixel irradiance history exists and matches this extent. */
  readonly pixelHistory: boolean;
  /** Probe radiance history exists and matches this extent. */
  readonly probeHistory: boolean;
  readonly worldBias: number;
  /** Card projection margin for world hits. */
  readonly cardMargin: number;
  /** Global SDF query settings: u32 max steps and f32 min step factor bytes. */
  readonly query: Uint8Array;
  /** Last accepted view geometry; absent after a geometric reset, which rejects all history. */
  readonly reprojection: ScreenProbeReprojection | undefined;
}

/**
 * Screen Probe history follows view geometry, not lighting: it survives a sun,
 * environment or fog change that resets TAA (UE Lumen keeps its history too).
 */
export interface ScreenProbeReprojection {
  readonly viewProjection: ArrayLike<number>;
  readonly cameraPosition: readonly [number, number, number];
}

/** Must match `ScreenProbeFrame` in ray-screen-probe.wgsl. */
export function packScreenProbeFrame(frame: ScreenProbeFrame): Uint8Array {
  const bytes = new Uint8Array(SCREEN_PROBE_FRAME_BYTES);
  const u = new Uint32Array(bytes.buffer);
  const f = new Float32Array(bytes.buffer);
  const l = frame.layout;
  u.set([l.width, l.height, l.tilesX, l.tilesY], 0);
  u.set([l.uniformCount, l.adaptiveCapacity, frame.downsample, frame.frameIndex >>> 0], 4);
  u.set(
    [
      frame.importance === 'brdf' ? 1 : 0,
      frame.screenSteps,
      (frame.sceneHistory ? 1 : 0) | (frame.pixelHistory ? 2 : 0) | (frame.probeHistory ? 4 : 0),
      frame.maxFrames,
    ],
    8,
  );
  f.set([...frame.environment, frame.maxDistance], 12);
  f.set([frame.thickness, frame.shortRangeAo, frame.worldBias, frame.cardMargin], 16);
  bytes.set(frame.query.subarray(0, 8), 80);
  const previous = frame.reprojection;
  if (previous !== undefined) {
    for (let i = 0; i < 16; i++) f[24 + i] = previous.viewProjection[i] ?? 0;
    f.set([...previous.cameraPosition, 1], 40);
  }
  return bytes;
}
