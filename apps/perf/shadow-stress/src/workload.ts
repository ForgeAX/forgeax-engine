import { type Quat, quat } from '@forgeax/engine-math';

export const WORKLOAD_VERSION = 1 as const;
export const SHADOW_STRESS_SEED = 0x5ad0c0de as const;
export const STATIC_CASTER_COUNT_DEFAULT = 4_000 as const;
export const STATIC_CASTER_COUNT_MAX = 50_000 as const;
/** Static casters are split into Instances entities of this many rows each. */
export const STATIC_CHUNK_SIZE = 500 as const;
export const MOVER_COUNT_DEFAULT = 128 as const;
export const MOVER_COUNT_MAX = 4_096 as const;
export const CHARACTER_COUNT_DEFAULT = 4 as const;
export const CHARACTER_COUNT_MAX = 64 as const;
/** Opt-in sub-texel static clutter that far directional cascades cull. */
export const DEBRIS_COUNT_MAX = 50_000 as const;
export const GROUND_HALF_EXTENT = 48 as const;
/** The low camera stands outside the caster field; its ground reaches past the far plane so no view ray escapes to void. */
export const LOW_CAMERA_GROUND_HALF_EXTENT = 256 as const;
export const DIRECTIONAL_CASCADE_COUNT = 4 as const;
export const SPOT_LIGHT_COUNT = 4 as const;
/** Opt-in shadowed point lights; each adds six cube-face shadow views. */
export const POINT_LIGHT_COUNT_MAX = 4 as const;
export const DIRECTIONAL_LIGHT_DIRECTION = [0.35, -0.85, -0.4] as const;
/** Opt-in individual casters; each receives one transform push per period, staggered. */
export const OCCASIONAL_COUNT_MAX = 4_096 as const;
export const OCCASIONAL_PERIOD_FRAMES = 300 as const;
/** Bounds of the opt-in `occasionalPeriod` override. */
export const OCCASIONAL_PERIOD_MIN = 16 as const;
export const OCCASIONAL_PERIOD_MAX = 4_000 as const;
/** Opt-in casters spawned and despawned every frame. */
export const SPAWN_STORM_COUNT_MAX = 1_024 as const;
/** LOD grid: individual spheres whose root mesh declares two lower levels. */
export const LOD_GRID_SIDE = 16 as const;
/** Bound of the opt-in `lodGrid` side override. */
export const LOD_GRID_SIDE_MAX = 64 as const;
export const LOD_GRID_SPACING = 1.2 as const;
export const LOD_SPHERE_RADIUS = 0.5 as const;
/** Absolute projected-height thresholds for LOD1 and LOD2. */
export const LOD_SCREEN_COVERAGE = [0.13, 0.08] as const;
export const LOD_OSCILLATION_PERIOD_SECONDS = 2 as const;
/** Opt-in individual alpha-blended cubes, ordered back-to-front by camera distance. */
export const TRANSPARENT_COUNT_MAX = 1_024 as const;

/** `low` orbits at eye height outside the caster field, so near casters occlude most of the scene. */
export type CameraMode = 'static' | 'orbit' | 'low';
export type RenderPathMode = 'forward' | 'deferred';
/** How the mover system publishes its rows: per-row range writes or a whole-column `World.set`. */
export type MoverWriteMode = 'rows' | 'set';

export interface WorkloadOptions {
  readonly staticCasterCount: number;
  readonly moverCount: number;
  /** Leading mover rows animated each Update; the rest stay at their first pose. */
  readonly activeMoverCount: number;
  readonly moverWrite: MoverWriteMode;
  readonly characterCount: number;
  readonly debrisCount: number;
  readonly pointCount: number;
  readonly camera: CameraMode;
  /** Characters cast directional shadows through skeleton capsules instead of cascade raster. */
  readonly capsuleShadow: boolean;
  /** Capsule shadows are a Deferred lighting term; Forward keeps the cascade raster. */
  readonly renderPath: RenderPathMode;
  /** Two-phase HZB occlusion of the main GPU-driven view; `gpuOcclusion=0` is the A/B baseline. */
  readonly gpuOcclusion: boolean;
  /** Individual casters each pushed once per `occasionalPeriod` frames, staggered. */
  readonly occasionalCount: number;
  /** Frames between two pushes of one occasional caster; default OCCASIONAL_PERIOD_FRAMES. */
  readonly occasionalPeriod: number;
  /** Casters spawned and despawned every frame. */
  readonly spawnStormCount: number;
  /** LOD sphere grid plus a camera distance that crosses both LOD thresholds. */
  readonly lodOscillate: boolean;
  /** LOD sphere grid side; 0 spawns no grid. `lodOscillate` alone implies LOD_GRID_SIDE. */
  readonly lodGridSide: number;
  /** Individual alpha-blended cubes sorted by camera distance. */
  readonly transparentCount: number;
  /** The main camera resolves through TAA. */
  readonly taa: boolean;
  /** Ground, static casters and debris declare `Mobility` static. */
  readonly mobilityStatic: boolean;
  /** Renderer GPU pass timing is enabled and summarized per pass. */
  readonly gpuPassTiming: boolean;
}

export type WorkloadConfigError =
  | {
      readonly code: 'workload-count-out-of-range';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly parameter: string; readonly value: string | undefined };
    }
  | {
      readonly code: 'workload-camera-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-capsule-shadow-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-gpu-occlusion-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-render-path-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-mover-write-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-lod-oscillate-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-taa-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-mobility-static-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    }
  | {
      readonly code: 'workload-gpu-timing-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly value: string };
    };

export type WorkloadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkloadConfigError };

function parseBounded(
  source: URLSearchParams,
  parameter: string,
  fallback: number,
  min: number,
  max: number,
): WorkloadResult<number> {
  const raw = source.get(parameter) ?? undefined;
  if (raw === undefined) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      ok: false,
      error: {
        code: 'workload-count-out-of-range',
        expected: `${parameter} must be an integer in [${min}, ${max}]`,
        hint: 'Correct the explicit scale parameter; the workload does not clamp or silently truncate it.',
        detail: { parameter, value: raw },
      },
    };
  }
  return { ok: true, value };
}

export function parseWorkloadOptions(source: URLSearchParams): WorkloadResult<WorkloadOptions> {
  const statics = parseBounded(source, 'statics', STATIC_CASTER_COUNT_DEFAULT, 1, STATIC_CASTER_COUNT_MAX);
  if (!statics.ok) return statics;
  const movers = parseBounded(source, 'movers', MOVER_COUNT_DEFAULT, 0, MOVER_COUNT_MAX);
  if (!movers.ok) return movers;
  const activeMovers = parseBounded(source, 'activeMovers', movers.value, 0, movers.value);
  if (!activeMovers.ok) return activeMovers;
  const moverWrite = source.get('moverWrite') ?? 'rows';
  if (moverWrite !== 'rows' && moverWrite !== 'set') {
    return {
      ok: false,
      error: {
        code: 'workload-mover-write-invalid',
        expected: "moverWrite must be 'rows' or 'set'",
        hint: 'Use moverWrite=rows for World.setArrayRange row writes or moverWrite=set for the whole-column World.set reference.',
        detail: { value: moverWrite },
      },
    };
  }
  const characters = parseBounded(source, 'characters', CHARACTER_COUNT_DEFAULT, 0, CHARACTER_COUNT_MAX);
  if (!characters.ok) return characters;
  const debris = parseBounded(source, 'debris', 0, 0, DEBRIS_COUNT_MAX);
  if (!debris.ok) return debris;
  const points = parseBounded(source, 'points', 0, 0, POINT_LIGHT_COUNT_MAX);
  if (!points.ok) return points;
  const camera = source.get('camera') ?? 'static';
  if (camera !== 'static' && camera !== 'orbit' && camera !== 'low') {
    return {
      ok: false,
      error: {
        code: 'workload-camera-invalid',
        expected: "camera must be 'static', 'orbit' or 'low'",
        hint: 'Use camera=static for a fixed view, camera=orbit to move the main view every frame, or camera=low for an occluded eye-height orbit.',
        detail: { value: camera },
      },
    };
  }
  const capsuleShadow = source.get('capsuleShadow') ?? '0';
  if (capsuleShadow !== '0' && capsuleShadow !== '1') {
    return {
      ok: false,
      error: {
        code: 'workload-capsule-shadow-invalid',
        expected: "capsuleShadow must be '0' or '1'",
        hint: 'Use capsuleShadow=1 to give every character a CapsuleShadow component, or omit it for cascade raster.',
        detail: { value: capsuleShadow },
      },
    };
  }
  const renderPath = source.get('renderPath') ?? 'forward';
  if (renderPath !== 'forward' && renderPath !== 'deferred') {
    return {
      ok: false,
      error: {
        code: 'workload-render-path-invalid',
        expected: "renderPath must be 'forward' or 'deferred'",
        hint: 'Use renderPath=deferred to admit capsule shadows; compare against renderPath=deferred with capsuleShadow=0.',
        detail: { value: renderPath },
      },
    };
  }
  const gpuOcclusion = source.get('gpuOcclusion') ?? '1';
  if (gpuOcclusion !== '0' && gpuOcclusion !== '1') {
    return {
      ok: false,
      error: {
        code: 'workload-gpu-occlusion-invalid',
        expected: "gpuOcclusion must be '0' or '1'",
        hint: 'Use gpuOcclusion=0 for the frustum-only baseline of an HZB occlusion A/B, or omit it.',
        detail: { value: gpuOcclusion },
      },
    };
  }
  const occasional = parseBounded(source, 'occasional', 0, 0, OCCASIONAL_COUNT_MAX);
  if (!occasional.ok) return occasional;
  const occasionalPeriod = parseBounded(
    source,
    'occasionalPeriod',
    OCCASIONAL_PERIOD_FRAMES,
    OCCASIONAL_PERIOD_MIN,
    OCCASIONAL_PERIOD_MAX,
  );
  if (!occasionalPeriod.ok) return occasionalPeriod;
  const spawnStorm = parseBounded(source, 'spawnStorm', 0, 0, SPAWN_STORM_COUNT_MAX);
  if (!spawnStorm.ok) return spawnStorm;
  const lodOscillate = source.get('lodOscillate') ?? '0';
  if (lodOscillate !== '0' && lodOscillate !== '1') {
    return {
      ok: false,
      error: {
        code: 'workload-lod-oscillate-invalid',
        expected: "lodOscillate must be '0' or '1'",
        hint: 'Use lodOscillate=1 to add the LOD sphere grid and oscillate the camera distance across its thresholds.',
        detail: { value: lodOscillate },
      },
    };
  }
  const lodGrid = parseBounded(
    source,
    'lodGrid',
    lodOscillate === '1' ? LOD_GRID_SIDE : 0,
    0,
    LOD_GRID_SIDE_MAX,
  );
  if (!lodGrid.ok) return lodGrid;
  const transparent = parseBounded(source, 'transparent', 0, 0, TRANSPARENT_COUNT_MAX);
  if (!transparent.ok) return transparent;
  const taa = source.get('taa') ?? '0';
  if (taa !== '0' && taa !== '1') {
    return {
      ok: false,
      error: {
        code: 'workload-taa-invalid',
        expected: "taa must be '0' or '1'",
        hint: 'Use taa=1 to resolve the main camera through TAA, or omit it for no antialiasing.',
        detail: { value: taa },
      },
    };
  }
  const mobilityStatic = source.get('mobilityStatic') ?? '0';
  if (mobilityStatic !== '0' && mobilityStatic !== '1') {
    return {
      ok: false,
      error: {
        code: 'workload-mobility-static-invalid',
        expected: "mobilityStatic must be '0' or '1'",
        hint: 'Use mobilityStatic=1 to declare the ground, static casters and debris Mobility static.',
        detail: { value: mobilityStatic },
      },
    };
  }
  const gpuTiming = source.get('gpuTiming') ?? '0';
  if (gpuTiming !== '0' && gpuTiming !== '1') {
    return {
      ok: false,
      error: {
        code: 'workload-gpu-timing-invalid',
        expected: "gpuTiming must be '0' or '1'",
        hint: 'Use gpuTiming=1 to record per-pass GPU durations, or omit it; timing queries add GPU work.',
        detail: { value: gpuTiming },
      },
    };
  }
  return {
    ok: true,
    value: {
      staticCasterCount: statics.value,
      moverCount: movers.value,
      activeMoverCount: activeMovers.value,
      moverWrite,
      characterCount: characters.value,
      debrisCount: debris.value,
      pointCount: points.value,
      camera,
      capsuleShadow: capsuleShadow === '1',
      renderPath,
      gpuOcclusion: gpuOcclusion === '1',
      occasionalCount: occasional.value,
      occasionalPeriod: occasionalPeriod.value,
      spawnStormCount: spawnStorm.value,
      lodOscillate: lodOscillate === '1',
      lodGridSide: lodGrid.value,
      transparentCount: transparent.value,
      taa: taa === '1',
      mobilityStatic: mobilityStatic === '1',
      gpuPassTiming: gpuTiming === '1',
    },
  };
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function writeYawScaleTranslation(
  out: Float32Array,
  offset: number,
  yaw: number,
  scale: readonly [number, number, number],
  x: number,
  y: number,
  z: number,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[offset] = c * scale[0];
  out[offset + 1] = 0;
  out[offset + 2] = -s * scale[0];
  out[offset + 3] = 0;
  out[offset + 4] = 0;
  out[offset + 5] = scale[1];
  out[offset + 6] = 0;
  out[offset + 7] = 0;
  out[offset + 8] = s * scale[2];
  out[offset + 9] = 0;
  out[offset + 10] = c * scale[2];
  out[offset + 11] = 0;
  out[offset + 12] = x;
  out[offset + 13] = y;
  out[offset + 14] = z;
  out[offset + 15] = 1;
}

/** Column-major mat4 rows for the static casters, split into fixed-size chunks. */
export function staticCasterChunks(options: WorkloadOptions): Float32Array[] {
  const random = mulberry32(SHADOW_STRESS_SEED);
  const chunks: Float32Array[] = [];
  const span = GROUND_HALF_EXTENT * 2 - 4;
  for (let first = 0; first < options.staticCasterCount; first += STATIC_CHUNK_SIZE) {
    const count = Math.min(STATIC_CHUNK_SIZE, options.staticCasterCount - first);
    const chunk = new Float32Array(count * 16);
    for (let index = 0; index < count; index++) {
      const width = 0.4 + random() * 0.8;
      const height = 0.5 + random() * 2.5;
      const x = -span / 2 + random() * span;
      const z = -span / 2 + random() * span;
      writeYawScaleTranslation(chunk, index * 16, random() * Math.PI, [width, height, width], x, height / 2, z);
    }
    chunks.push(chunk);
  }
  return chunks;
}

/** Column-major mat4 rows for 4-10 cm debris cubes, split into fixed-size chunks. */
export function debrisChunks(options: WorkloadOptions): Float32Array[] {
  const random = mulberry32(SHADOW_STRESS_SEED ^ 0xdeb415);
  const chunks: Float32Array[] = [];
  const span = GROUND_HALF_EXTENT * 2 - 4;
  for (let first = 0; first < options.debrisCount; first += STATIC_CHUNK_SIZE) {
    const count = Math.min(STATIC_CHUNK_SIZE, options.debrisCount - first);
    const chunk = new Float32Array(count * 16);
    for (let index = 0; index < count; index++) {
      const size = 0.04 + random() * 0.06;
      const x = -span / 2 + random() * span;
      const z = -span / 2 + random() * span;
      writeYawScaleTranslation(chunk, index * 16, random() * Math.PI, [size, size, size], x, size / 2, z);
    }
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Rewrites the first `active` moving instanced parts in place for simulation
 * time `seconds`; `count` sets the ring layout.
 */
export function writeMoverTransforms(out: Float32Array, count: number, seconds: number, active = count): void {
  for (let index = 0; index < active; index++) {
    const phase = (index / Math.max(1, count)) * Math.PI * 2;
    const radius = 6 + (index % 8) * 1.5;
    const angle = phase + seconds * 0.6;
    const y = 1.5 + Math.sin(seconds * 2 + index) * 0.75;
    writeYawScaleTranslation(out, index * 16, angle, [0.6, 0.6, 0.6], Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  }
}

export function characterPositions(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    const angle = (index / Math.max(1, count)) * Math.PI * 2;
    out[index * 3] = Math.cos(angle) * 3;
    out[index * 3 + 1] = 0.9;
    out[index * 3 + 2] = Math.sin(angle) * 3;
  }
  return out;
}

export function pointLightPositions(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    const angle = (index / Math.max(1, count)) * Math.PI * 2;
    out[index * 3] = Math.cos(angle) * 8;
    out[index * 3 + 1] = 4;
    out[index * 3 + 2] = Math.sin(angle) * 8;
  }
  return out;
}

export function spotLightPositions(): Float32Array {
  const out = new Float32Array(SPOT_LIGHT_COUNT * 3);
  for (let index = 0; index < SPOT_LIGHT_COUNT; index++) {
    const angle = (index / SPOT_LIGHT_COUNT) * Math.PI * 2 + Math.PI / 4;
    out[index * 3] = Math.cos(angle) * 14;
    out[index * 3 + 1] = 10;
    out[index * 3 + 2] = Math.sin(angle) * 14;
  }
  return out;
}

/** Individual caster positions on a ring outside the character circle. */
export function occasionalPositions(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    const angle = (index / Math.max(1, count)) * Math.PI * 2;
    const radius = 12 + (index % 16) * 1.5;
    out[index * 3] = Math.cos(angle) * radius;
    out[index * 3 + 1] = 0.4;
    out[index * 3 + 2] = Math.sin(angle) * radius;
  }
  return out;
}

/** Transparent cubes on a jittered grid around the origin, inside every orbit view. */
export function transparentPositions(count: number): Float32Array {
  const random = mulberry32((SHADOW_STRESS_SEED ^ 0x7a115) >>> 0);
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  const spacing = 1.6;
  const out = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    out[index * 3] = ((index % side) - (side - 1) / 2) * spacing + (random() - 0.5) * 0.4;
    out[index * 3 + 1] = 1 + random() * 2;
    out[index * 3 + 2] = (Math.floor(index / side) - (side - 1) / 2) * spacing + (random() - 0.5) * 0.4;
  }
  return out;
}

/** The staggered frame offset at which occasional caster `index` is pushed each period. */
export function occasionalPushFrame(
  index: number,
  count: number,
  period: number = OCCASIONAL_PERIOD_FRAMES,
): number {
  return Math.floor((index * period) / Math.max(1, count));
}

/** Deterministic storm caster positions for `frame`; each frame gets a fresh set. */
export function spawnStormPositions(count: number, frame: number): Float32Array {
  const random = mulberry32((SHADOW_STRESS_SEED ^ Math.imul(frame + 1, 0x9e3779b1)) >>> 0);
  const span = GROUND_HALF_EXTENT * 2 - 8;
  const out = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    out[index * 3] = -span / 2 + random() * span;
    out[index * 3 + 1] = 0.5 + random() * 2;
    out[index * 3 + 2] = -span / 2 + random() * span;
  }
  return out;
}

/** LOD sphere grid centred on the origin. */
export function lodGridPositions(side: number = LOD_GRID_SIDE): Float32Array {
  const out = new Float32Array(side * side * 3);
  const origin = ((side - 1) * LOD_GRID_SPACING) / 2;
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const index = row * side + column;
      out[index * 3] = column * LOD_GRID_SPACING - origin;
      out[index * 3 + 1] = LOD_SPHERE_RADIUS + 1;
      out[index * 3 + 2] = row * LOD_GRID_SPACING - origin;
    }
  }
  return out;
}

/**
 * Camera distance multiplier: 1 without LOD oscillation, otherwise a cosine
 * sweep from 0.45 to 1.25 of the base distance. The sphere grid's projected
 * height then spans roughly 0.18 to 0.06, crossing both LOD thresholds.
 */
export function cameraDistanceScale(lodOscillate: boolean, seconds: number): number {
  if (!lodOscillate) return 1;
  return 0.45 + 0.4 * (1 - Math.cos((2 * Math.PI * seconds) / LOD_OSCILLATION_PERIOD_SECONDS));
}

/** Camera position and orientation looking at the origin. */
export function groundHalfExtent(camera: CameraMode): number {
  return camera === 'low' ? LOW_CAMERA_GROUND_HALF_EXTENT : GROUND_HALF_EXTENT;
}

export function cameraPose(
  mode: CameraMode,
  seconds: number,
  lodOscillate = false,
): { readonly pos: [number, number, number]; readonly quat: Quat } {
  const angle = mode === 'static' ? 0 : seconds * 0.25;
  if (mode === 'low') {
    const pos: [number, number, number] = [Math.sin(angle) * 56, 1.5, Math.cos(angle) * 56];
    return { pos, quat: quat.fromLookAt(quat.create(), pos, [0, 1.5, 0], [0, 1, 0]) };
  }
  const scale = cameraDistanceScale(lodOscillate, seconds);
  const pos: [number, number, number] = [Math.sin(angle) * 34 * scale, 18 * scale, Math.cos(angle) * 34 * scale];
  return { pos, quat: quat.fromLookAt(quat.create(), pos, [0, 0, 0], [0, 1, 0]) };
}

export function workloadFingerprint(options: WorkloadOptions): string {
  const identity = `perf-shadow-stress/v${WORKLOAD_VERSION}|seed=${SHADOW_STRESS_SEED}|ground=${groundHalfExtent(options.camera)}|chunk=${STATIC_CHUNK_SIZE}|statics=${options.staticCasterCount}|movers=${options.moverCount}${options.activeMoverCount < options.moverCount ? `|activeMovers=${options.activeMoverCount}` : ''}${options.moverWrite === 'set' ? '|moverWrite=set' : ''}|characters=${options.characterCount}|debris=${options.debrisCount}|points=${options.pointCount}|camera=${options.camera}${options.capsuleShadow ? '|capsuleShadow=1' : ''}${options.renderPath === 'deferred' ? '|renderPath=deferred' : ''}${options.gpuOcclusion ? '' : '|gpuOcclusion=0'}${options.occasionalCount > 0 ? `|occasional=${options.occasionalCount}` : ''}${options.occasionalPeriod !== OCCASIONAL_PERIOD_FRAMES ? `|occasionalPeriod=${options.occasionalPeriod}` : ''}${options.spawnStormCount > 0 ? `|spawnStorm=${options.spawnStormCount}` : ''}${options.lodOscillate ? '|lodOscillate=1' : ''}${options.lodGridSide !== (options.lodOscillate ? LOD_GRID_SIDE : 0) ? `|lodGrid=${options.lodGridSide}` : ''}${options.transparentCount > 0 ? `|transparent=${options.transparentCount}` : ''}${options.taa ? '|taa=1' : ''}${options.mobilityStatic ? '|mobilityStatic=1' : ''}${options.gpuPassTiming ? '|gpuTiming=1' : ''}|cascades=${DIRECTIONAL_CASCADE_COUNT}|spots=${SPOT_LIGHT_COUNT}`;
  return `${identity}|hash=${fnv1a32(identity)}`;
}
