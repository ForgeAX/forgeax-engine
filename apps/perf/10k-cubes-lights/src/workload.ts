export const WORKLOAD_VERSION = 3 as const;
export const PERF_WORKLOAD_SEED = 0x010c0b35 as const;
export const CUBE_COUNT_DEFAULT = 10_000 as const;
export const CUBE_COUNT_MAX = 100_000 as const;
export const LIGHT_COUNT_MAX = 256 as const;
export const POINT_LIGHT_COUNT_DEFAULT = 16 as const;
export const SPOT_LIGHT_COUNT_DEFAULT = 16 as const;
/** Three r184 and ForgeaX both use inverse-square punctual attenuation. */
export const PUNCTUAL_DECAY_EXPONENT = 2 as const;
/** Fixed sun shared by the Engine and Three.js pressure consumers. */
export const DIRECTIONAL_LIGHT_DIRECTION = [0.4, -0.8, -0.4] as const;
export const DIRECTIONAL_LIGHT_COLOR = [1, 1, 1] as const;
export const DIRECTIONAL_LIGHT_INTENSITY = 1 as const;
export const DIRECTIONAL_LIGHT_CAST_SHADOW = false as const;
export const VOLUME_MIN = [-24, -16, -24] as const;
export const VOLUME_MAX = [24, 16, 24] as const;

export interface WorkloadOptions {
  readonly cubeCount: number;
  readonly pointLightCount: number;
  readonly spotLightCount: number;
}

export type WorkloadConfigError =
  | {
      readonly code: 'workload-count-out-of-range';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly parameter: string; readonly value: string | undefined };
    }
  | {
      readonly code: 'workload-light-budget-exceeded';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly pointLightCount: number; readonly spotLightCount: number };
    };

export type WorkloadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkloadConfigError };

function parseBounded(
  source: URLSearchParams,
  parameter: string,
  fallback: number,
  max: number,
): WorkloadResult<number> {
  const raw = source.get(parameter) ?? undefined;
  if (raw === undefined) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    return {
      ok: false,
      error: {
        code: 'workload-count-out-of-range',
        expected: `${parameter} must be an integer in [0, ${max}]`,
        hint: 'Correct the explicit scale parameter; the workload does not clamp or silently truncate it.',
        detail: { parameter, value: raw },
      },
    };
  }
  return { ok: true, value };
}

export function parseWorkloadOptions(source: URLSearchParams): WorkloadResult<WorkloadOptions> {
  const cubes = parseBounded(source, 'cubes', CUBE_COUNT_DEFAULT, CUBE_COUNT_MAX);
  if (!cubes.ok || cubes.value < 1) {
    return cubes.ok
      ? {
          ok: false,
          error: {
            code: 'workload-count-out-of-range',
            expected: `cubes must be an integer in [1, ${CUBE_COUNT_MAX}]`,
            hint: 'Use at least one cube; the pressure consumer never substitutes a clear-only scene.',
            detail: { parameter: 'cubes', value: source.get('cubes') ?? undefined },
          },
        }
      : cubes;
  }
  const point = parseBounded(source, 'pointLights', POINT_LIGHT_COUNT_DEFAULT, LIGHT_COUNT_MAX);
  if (!point.ok) return point;
  const spot = parseBounded(source, 'spotLights', SPOT_LIGHT_COUNT_DEFAULT, LIGHT_COUNT_MAX);
  if (!spot.ok) return spot;
  if (point.value + spot.value > LIGHT_COUNT_MAX) {
    return {
      ok: false,
      error: {
        code: 'workload-light-budget-exceeded',
        expected: `pointLights + spotLights must be <= ${LIGHT_COUNT_MAX}`,
        hint: 'Lower one explicit light count; the HDRP component path does not silently truncate lights.',
        detail: { pointLightCount: point.value, spotLightCount: spot.value },
      },
    };
  }
  return {
    ok: true,
    value: { cubeCount: cubes.value, pointLightCount: point.value, spotLightCount: spot.value },
  };
}

export function createWorkloadOptions(): WorkloadResult<WorkloadOptions> {
  return parseWorkloadOptions(new URLSearchParams());
}

export function workloadFingerprint(options: WorkloadOptions): string {
  const bounds = `${VOLUME_MIN.join(',')}..${VOLUME_MAX.join(',')}`;
  const directional = `dir(${DIRECTIONAL_LIGHT_DIRECTION.join(',')}),color(${DIRECTIONAL_LIGHT_COLOR.join(',')}),intensity(${DIRECTIONAL_LIGHT_INTENSITY}),shadow(${DIRECTIONAL_LIGHT_CAST_SHADOW ? 1 : 0})`;
  const identity = `perf-10k-cubes-lights/v${WORKLOAD_VERSION}|seed=${PERF_WORKLOAD_SEED}|bounds=${bounds}|mesh=HANDLE_CUBE|material=shared-standard-pbr|camera=center-yaw|directional=${directional}|punctualDecay=${PUNCTUAL_DECAY_EXPONENT}|cubes=${options.cubeCount}|pointLights=${options.pointLightCount}|spotLights=${options.spotLightCount}`;
  return `${identity}|hash=${fnv1a32(identity)}`;
}

export function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function cubePositions(options: WorkloadOptions): Float32Array {
  const random = mulberry32(PERF_WORKLOAD_SEED);
  const positions = new Float32Array(options.cubeCount * 3);
  for (let index = 0; index < options.cubeCount; index++) {
    const base = index * 3;
    positions[base] = VOLUME_MIN[0] + random() * (VOLUME_MAX[0] - VOLUME_MIN[0]);
    positions[base + 1] = VOLUME_MIN[1] + random() * (VOLUME_MAX[1] - VOLUME_MIN[1]);
    positions[base + 2] = VOLUME_MIN[2] + random() * (VOLUME_MAX[2] - VOLUME_MIN[2]);
  }
  return positions;
}

export function positionsChecksum(positions: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < positions.length; index++) {
    const value = Math.round((positions[index] ?? 0) * 100_000);
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function yawQuaternion(angle: number): [number, number, number, number] {
  return [0, Math.sin(angle * 0.5), 0, Math.cos(angle * 0.5)];
}
