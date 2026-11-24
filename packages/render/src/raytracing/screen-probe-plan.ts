import {
  SCREEN_PROBE_CURRENT_SUPPORT_MASK,
  SDF_SURFACE_ROOT_REQUEST_BYTES,
} from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import type { StandardScreenProbes } from '../pipeline/standard-profile';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import { packWorldFrameSource, type WorldFrameSource } from './world-traversal';

/** Octahedral radiance texels per probe edge (UE ScreenProbeTracingOctahedronResolution). */
const SCREEN_PROBE_OCT = 8;
export const SCREEN_PROBE_TEXELS = SCREEN_PROBE_OCT * SCREEN_PROBE_OCT;
/** Depth geometry32 plus canonical origin enclosure and construction lineage64. */
export const SCREEN_PROBE_RECORD_BYTES = 96;
/** Receiver continuation carries originHi and the same primitive construction context. */
export const SCREEN_PROBE_ROOT_REQUEST_BYTES = SDF_SURFACE_ROOT_REQUEST_BYTES + 32;
/** Actual-direction point/four-sample distribution, support (or age) and closest hit. */
export const SCREEN_PROBE_RADIANCE_BYTES = 40;
/** Retained geometry and directional transport records with effective history ages. */
export const SCREEN_PROBE_HISTORY_BYTES =
  SCREEN_PROBE_RECORD_BYTES + SCREEN_PROBE_TEXELS * SCREEN_PROBE_RADIANCE_BYTES;
export const SCREEN_PROBE_FRAME_BYTES = 192;
/** Per-pixel history metadata: view distance, encoded normal, sample count, and flags with optional f16 AO. */
export const SCREEN_PROBE_META_BYTES = 16;

/** Set by a hardware miss that traced all the way to the cache boundary. */
export const SCREEN_PROBE_REACHED_CACHE = 1 << 15;

/** Relative motion at a qualified hardware hit. Cache level occupies bits 16..18. */
export const SCREEN_PROBE_HIT_MOVING = 1 << 20;

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
  /** Near-field hardware traversal ended at an admitted radiance cache boundary. */
  cacheBoundary: 5,
} as const;

export const SCREEN_PROBE_DEFAULTS: StandardScreenProbes = Object.freeze({
  downsample: 16,
  adaptiveFraction: 0.5,
  importance: 'brdf',
  screenTrace: Object.freeze({ maxSteps: 50, thickness: 0.02 }),
  filterPasses: 3,
  shortRangeAo: 0.5,
  maxFrames: 10,
}) as StandardScreenProbes;

const KEYS = [
  'downsample',
  'adaptiveFraction',
  'adaptiveCandidates',
  'importance',
  'screenTrace',
  'filterPasses',
  'irradiance',
  'integration',
  'interpolation',
  'shortRangeAo',
  'shortRangeAoMode',
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
  if (
    probes.integration !== undefined &&
    (probes.integration !== 'screen-space' || probes.irradiance === undefined)
  )
    return rayReferenceFailure('screen-space integration requires preintegrated probe irradiance');
  if (
    probes.interpolation !== undefined &&
    (probes.interpolation !== 'stochastic' || probes.integration !== 'screen-space')
  )
    return rayReferenceFailure('stochastic interpolation requires screen-space integration');
  if (
    probes.shortRangeAoMode !== undefined &&
    (probes.integration !== 'screen-space' ||
      !(probes.shortRangeAo > 0) ||
      !['half-scalar', 'full-bent'].includes(probes.shortRangeAoMode))
  )
    return rayReferenceFailure(
      'dedicated short-range AO requires a positive radius and screen-space integration',
    );
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
    (probes.adaptiveCandidates !== undefined && ![4, 8, 16].includes(probes.adaptiveCandidates)) ||
    (probes.importance !== 'uniform' && probes.importance !== 'brdf') ||
    !traceValid ||
    (probes.irradiance !== undefined &&
      probes.irradiance !== 'probe-octahedral' &&
      probes.irradiance !== 'probe-sh3') ||
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
  readonly adaptiveSlots: 4 | 8 | 16;
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
  const adaptiveCapacity = Math.floor(uniformCount * probes.adaptiveFraction);
  return {
    width,
    height,
    tilesX,
    tilesY,
    uniformCount,
    adaptiveSlots: probes.adaptiveCandidates ?? 4,
    adaptiveCapacity,
    probeCount: uniformCount + adaptiveCapacity,
  };
}

/** The single Screen allocation ledger. Optional continuation words belong to
 * the same extent/lifetime and device span gate as ordinary rays and history.
 * Aggregate bytes are derived from this record, not a second budget registry. */
export function screenProbeAllocationSizes(
  layout: ScreenProbeLayout,
  limit: number,
  paidRoot = false,
  receiverSourceBytes = 0,
  screenDepthHistory = false,
) {
  if (
    !Number.isSafeInteger(receiverSourceBytes) ||
    receiverSourceBytes < 0 ||
    receiverSourceBytes > limit
  )
    throw new Error('screen-probe receiverSource exceeds the storage binding limit');
  const pixels = layout.width * layout.height,
    texels = layout.probeCount * SCREEN_PROBE_TEXELS;
  const sizes = {
    probes: layout.probeCount * SCREEN_PROBE_RECORD_BYTES,
    adaptiveCount: Math.max(
      16,
      (1 + Math.ceil((layout.uniformCount * layout.adaptiveSlots) / 64)) * 4,
    ),
    tileAdaptive: layout.uniformCount * layout.adaptiveSlots * 4,
    rays: texels * 32,
    radianceA: texels * SCREEN_PROBE_RADIANCE_BYTES,
    radianceB: texels * SCREEN_PROBE_RADIANCE_BYTES,
    probeHistoryA: layout.probeCount * SCREEN_PROBE_HISTORY_BYTES,
    probeHistoryB: layout.probeCount * SCREEN_PROBE_HISTORY_BYTES,
    integrated: pixels * 16,
    historyA: pixels * 16,
    historyB: pixels * 16,
    metaA: pixels * SCREEN_PROBE_META_BYTES,
    metaB: pixels * SCREEN_PROBE_META_BYTES,
    previousScene: pixels * 8,
    ...(screenDepthHistory ? { previousScreenDepth: pixels * 4 } : {}),
    ...(paidRoot ? { rootRequests: texels * SCREEN_PROBE_ROOT_REQUEST_BYTES } : {}),
    ...(receiverSourceBytes > 0 ? { receiverSource: receiverSourceBytes } : {}),
  };
  for (const [slot, size] of Object.entries(sizes)) {
    if (!Number.isSafeInteger(size) || size < 1 || size > limit)
      throw new Error(
        `screen-probe ${slot} of ${size} bytes exceeds the storage binding limit ${limit}`,
      );
  }
  return sizes;
}

export interface ScreenProbeFrame {
  /** Renderer reconstruction method; absence retains strict reference reconstruction. */
  readonly reconstruction?: 'current-support';
  /** Accepted scene revision, independent of the receiver projection's header. */
  readonly receiverRevision?: number;
  readonly layout: Omit<ScreenProbeLayout, 'adaptiveSlots'> & {
    readonly adaptiveSlots?: ScreenProbeLayout['adaptiveSlots'];
  };
  readonly downsample: number;
  readonly frameIndex: number;
  readonly importance: 'uniform' | 'brdf';
  readonly stochasticInterpolation?: boolean;
  readonly sh3Irradiance?: boolean;
  readonly shortRangeAoMode?: StandardScreenProbes['shortRangeAoMode'];
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
  /** Accumulate in pixel history; keep the last probe sample for ray guiding. */
  readonly pixelOwnedHistory?: boolean;
  readonly worldBias: number;
  /** Card projection margin for world hits. */
  readonly cardMargin: number;
  /** Global SDF query settings: u32 max steps and f32 min step factor bytes. */
  readonly query: Uint8Array;
  /** Last accepted view geometry; absent after a geometric reset, which rejects all history. */
  readonly reprojection: ScreenProbeReprojection | undefined;
  readonly worldSource: WorldFrameSource;
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
      (frame.reconstruction === 'current-support'
        ? SCREEN_PROBE_CURRENT_SUPPORT_MASK |
          (frame.worldSource.traversal === 'ray-query' ? SCREEN_PROBE_CURRENT_SUPPORT_MASK << 1 : 0)
        : 0) |
        (frame.sceneHistory ? 1 : 0) |
        (frame.pixelHistory ? 2 : 0) |
        (frame.probeHistory ? 4 : 0),
      frame.maxFrames,
    ],
    8,
  );
  f.set([...frame.environment, frame.maxDistance], 12);
  f.set([frame.thickness, frame.shortRangeAo, frame.worldBias, frame.cardMargin], 16);
  bytes.set(frame.query.subarray(0, 8), 80);
  u[22] = frame.receiverRevision ?? 0;
  u[23] =
    (l.adaptiveSlots ?? 4) |
    (frame.stochasticInterpolation === true ? 32 : 0) |
    (frame.sh3Irradiance === true ? 64 : 0) |
    (frame.shortRangeAoMode === 'half-scalar' ? 128 : 0) |
    (frame.shortRangeAoMode === undefined ? 0 : 256) |
    (frame.pixelOwnedHistory === true ? 512 : 0);
  u.set(packWorldFrameSource(frame.worldSource).unwrap(), 44);
  const previous = frame.reprojection;
  if (previous !== undefined) {
    for (let i = 0; i < 16; i++) f[24 + i] = previous.viewProjection[i] ?? 0;
    f.set([...previous.cameraPosition, 1], 40);
  }
  return bytes;
}
