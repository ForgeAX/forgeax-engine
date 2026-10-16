import type { CloudDensityCache } from './density';
import { integrateCloudSolarColumn } from './optics';
import type { ValidatedCloudLayer } from './parameters';

export interface CloudShadowProjection {
  readonly revision: number;
  readonly resolution: number;
  readonly range: number;
  readonly texelSize: number;
  readonly center: readonly [number, number, number];
  readonly origin: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly sunDirection: readonly [number, number, number];
  readonly lowSun: boolean;
}

export interface CloudShadowSample {
  readonly transmittance: number;
  readonly uv: readonly [number, number] | undefined;
  readonly valid: boolean;
  readonly fallback: 'none' | 'low-sun' | 'outside-range' | 'empty-coverage';
  readonly revision: number;
}

function normalize(vector: ArrayLike<number>): readonly [number, number, number] {
  const x = vector[0] ?? 0;
  const y = vector[1] ?? 0;
  const z = vector[2] ?? 0;
  const length = Math.hypot(x, y, z);
  return length <= 1e-8 ? [0, 1, 0] : [x / length, y / length, z / length];
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): readonly [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

function stableRevision(input: {
  readonly center: readonly [number, number, number];
  readonly sunDirection: readonly [number, number, number];
  readonly range: number;
  readonly resolution: number;
}): number {
  let hash = 2166136261;
  const values = [...input.center, ...input.sunDirection, input.range, input.resolution];
  for (const value of values) {
    const bits = new Float32Array([value]);
    const bytes = new Uint8Array(bits.buffer);
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  }
  return hash >>> 0;
}

/**
 * Build a camera-independent light-space projection. The center is a world
 * anchor chosen by Render (usually the active scene bounds), and is snapped to
 * one texel so camera motion cannot crawl the cloud shadow.
 */
export function createCloudShadowProjection(input: {
  readonly center: readonly [number, number, number];
  readonly sunDirection: readonly [number, number, number];
  readonly range: number;
  readonly resolution?: number;
}): CloudShadowProjection {
  const sunDirection = normalize(input.sunDirection);
  const resolution = Math.max(16, Math.floor(input.resolution ?? 1024));
  const range = Math.max(1, input.range);
  const texelSize = range / resolution;
  const reference = Math.abs(sunDirection[1]) < 0.95 ? ([0, 1, 0] as const) : ([1, 0, 0] as const);
  const right = normalize(cross(reference, sunDirection));
  const up = normalize(cross(sunDirection, right));
  const center = input.center;
  const lightX = dot(center, right);
  const lightY = dot(center, up);
  const lightZ = dot(center, sunDirection);
  const snappedX = Math.floor(lightX / texelSize + 0.5) * texelSize;
  const snappedY = Math.floor(lightY / texelSize + 0.5) * texelSize;
  const origin: [number, number, number] = [
    right[0] * snappedX + up[0] * snappedY + sunDirection[0] * lightZ,
    right[1] * snappedX + up[1] * snappedY + sunDirection[1] * lightZ,
    right[2] * snappedX + up[2] * snappedY + sunDirection[2] * lightZ,
  ];
  return Object.freeze({
    revision: stableRevision({ center, sunDirection, range, resolution }),
    resolution,
    range,
    texelSize,
    center: Object.freeze([...center] as [number, number, number]),
    origin: Object.freeze(origin),
    right,
    up,
    sunDirection,
    lowSun: sunDirection[1] <= 0.08,
  });
}

export function projectCloudShadowUv(
  projection: CloudShadowProjection,
  position: readonly [number, number, number],
): { readonly uv: readonly [number, number]; readonly inRange: boolean } {
  const relative: [number, number, number] = [
    position[0] - projection.origin[0],
    position[1] - projection.origin[1],
    position[2] - projection.origin[2],
  ];
  const x = dot(relative, projection.right);
  const y = dot(relative, projection.up);
  const uv: [number, number] = [0.5 + x / projection.range, 0.5 + y / projection.range];
  return { uv, inRange: uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1 };
}

/** Evaluate the stable world-space shadow term used by surface and volume sun paths. */
export function sampleCloudShadow(
  params: ValidatedCloudLayer,
  projection: CloudShadowProjection,
  worldPosition: readonly [number, number, number],
  options: { readonly cache?: CloudDensityCache; readonly timeSeconds?: number } = {},
): CloudShadowSample {
  const projected = projectCloudShadowUv(projection, worldPosition);
  if (projection.lowSun) {
    return {
      transmittance: 1,
      uv: projected.uv,
      valid: false,
      fallback: 'low-sun',
      revision: projection.revision,
    };
  }
  if (!projected.inRange) {
    return {
      transmittance: 1,
      uv: projected.uv,
      valid: false,
      fallback: 'outside-range',
      revision: projection.revision,
    };
  }
  if (params.coverage >= 1 || params.density <= 0) {
    return {
      transmittance: 1,
      uv: projected.uv,
      valid: false,
      fallback: 'empty-coverage',
      revision: projection.revision,
    };
  }
  const integrated = integrateCloudSolarColumn(params, worldPosition, projection.sunDirection, {
    steps: 20,
    maxDistance: projection.range,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.timeSeconds === undefined ? {} : { timeSeconds: options.timeSeconds }),
  });
  return {
    transmittance: integrated.transmittance,
    uv: projected.uv,
    valid: integrated.entered,
    fallback: 'none',
    revision: projection.revision,
  };
}
