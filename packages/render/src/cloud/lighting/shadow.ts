import type { CloudRgb } from '../contracts';
import { sphereInterval } from '../tracing/geometry';
import { ue5CloudShadowTraceSamples } from '../tracing/policy';
import { cloudShadowSpatialLayout } from './shadow-spatial-layout';

/** UE shadow near-plane rules, independent of camera clipping and planet visibility. */
export function cloudBsmTraceInterval(
  origin: CloudRgb,
  direction: CloudRgb,
  radius: number,
  bottom: number,
  thickness: number,
): readonly [number, number] {
  const radial = Math.hypot(...origin);
  const projection = origin[0] * direction[0] + origin[1] * direction[1] + origin[2] * direction[2];
  const outer = sphereInterval(radial, projection, radius + bottom + thickness);
  if (outer === undefined) return [-1, -1];
  const inner = sphereInterval(radial, projection, radius + bottom);
  if (inner !== undefined) {
    if (inner.entryMeters <= 0 || inner.exitMeters <= 0) return [0, 0];
    return [Math.max(0, outer.entryMeters), Math.max(0, inner.entryMeters)];
  }
  return [Math.max(0, outer.entryMeters), Math.max(0, outer.exitMeters)];
}
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
  readonly verticalBasisThreshold?: number;
  readonly snapTexelSize?: number;
}): CloudShadowProjection {
  const sunDirection = normalize(input.sunDirection);
  const resolution = Math.max(1, Math.floor(input.resolution ?? 1024));
  const range = Math.max(1, input.range);
  const texelSize = range / resolution;
  const reference =
    Math.abs(sunDirection[1]) < (input.verticalBasisThreshold ?? 0.95)
      ? ([0, 1, 0] as const)
      : ([1, 0, 0] as const);
  const snapTexelSize = input.snapTexelSize ?? texelSize;
  const right = normalize(cross(reference, sunDirection));
  const up = normalize(cross(sunDirection, right));
  const center = input.center;
  const lightX = dot(center, right);
  const lightY = dot(center, up);
  const lightZ = dot(center, sunDirection);
  const snappedX = Math.floor(lightX / snapTexelSize + 0.5) * snapTexelSize;
  const snappedY = Math.floor(lightY / snapTexelSize + 0.5) * snapTexelSize;
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

export interface CloudShadowSample {
  readonly frontDepthMeters: number;
  readonly meanExtinctionPerMeter: number;
  readonly maxOpticalDepth: number;
}

export interface CloudShadowSegment {
  readonly midpointMeters: number;
  readonly lengthMeters: number;
}

/** Secondary rays cluster samples near the receiving point. */
export function cloudShadowSegment(
  index: number,
  count: number,
  distanceMeters: number,
): CloudShadowSegment {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0
  ) {
    throw new RangeError('Invalid cloud shadow segment');
  }
  const start = (index / count) ** 2;
  const end = ((index + 1) / count) ** 2;
  return {
    midpointMeters: distanceMeters * (start + end) * 0.5,
    lengthMeters: distanceMeters * (end - start),
  };
}

function nonnegative(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('Invalid cloud shadow coefficient');
  return value;
}

export function cloudRayShadowTransmittance(
  distanceMeters: number,
  count: number,
  sampleExtinction: (distanceMeters: number) => number,
  occlusion: number,
  extraOctaves: 0 | 1 | 2,
): readonly number[] {
  nonnegative(occlusion);
  const tau = new Array<number>(extraOctaves + 1).fill(0);
  for (let index = 0; index < count; index++) {
    const segment = cloudShadowSegment(index, count, distanceMeters);
    let extinction = nonnegative(sampleExtinction(segment.midpointMeters));
    let factor = Math.min(1, occlusion);
    for (let octave = 0; octave <= extraOctaves; octave++) {
      tau[octave] = (tau[octave] ?? 0) + extinction * segment.lengthMeters;
      extinction *= factor;
      factor *= factor;
    }
  }
  // Validate zero-count inputs as well as normal segments.
  cloudShadowSegment(0, count, distanceMeters);
  return tau.map((value) => Math.exp(-value));
}

/** BSM uses linear midpoint samples, unlike the secondary ray distribution. */
export function buildCloudShadowSample(
  startMeters: number,
  endMeters: number,
  count: number,
  sampleExtinction: (distanceMeters: number) => CloudRgb,
  strength = 1,
  depthBiasMeters = 0,
): CloudShadowSample {
  nonnegative(startMeters);
  nonnegative(endMeters);
  nonnegative(strength);
  if (
    endMeters < startMeters ||
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isFinite(depthBiasMeters)
  )
    throw new RangeError('Invalid cloud shadow map interval');
  const step = (endMeters - startMeters) / count;
  let front = endMeters;
  let sum = 0;
  let nonempty = 0;
  for (let index = 0; index < count; index++) {
    const distance = startMeters + (index + 0.5) * step;
    const extinction = sampleExtinction(distance);
    const gray =
      (nonnegative(extinction[0]) + nonnegative(extinction[1]) + nonnegative(extinction[2])) / 3;
    if (gray > 0) {
      front = Math.min(front, distance);
      nonempty++;
    }
    sum += gray;
  }
  return {
    frontDepthMeters: Math.max(0, front + depthBiasMeters),
    meanExtinctionPerMeter: (strength * sum) / Math.max(1, nonempty),
    maxOpticalDepth: strength * sum * step,
  };
}

export function cloudShadowOpticalDepth(sample: CloudShadowSample, depthMeters: number): number {
  return Math.min(
    sample.maxOpticalDepth,
    sample.meanExtinctionPerMeter * Math.max(0, depthMeters - sample.frontDepthMeters),
  );
}

export function cloudMapShadowTransmittance(
  tau: number,
  occlusion: number,
  octave: 0 | 1 | 2,
): number {
  return Math.exp(
    -nonnegative(tau) * (octave === 0 ? 1 : Math.min(1, nonnegative(occlusion)) ** octave),
  );
}

/** Bilinear filtering interpolates encoded values before evaluating optical depth. */
export function filterCloudShadowSamples(
  samples: readonly [CloudShadowSample, CloudShadowSample, CloudShadowSample, CloudShadowSample],
  x: number,
  y: number,
): CloudShadowSample {
  const u = Math.min(1, Math.max(0, x));
  const v = Math.min(1, Math.max(0, y));
  const weights = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
  const weighted = (field: keyof CloudShadowSample): number =>
    samples.reduce((sum, sample, index) => sum + sample[field] * (weights[index] ?? 0), 0);
  return {
    frontDepthMeters: weighted('frontDepthMeters'),
    meanExtinctionPerMeter: weighted('meanExtinctionPerMeter'),
    maxOpticalDepth: weighted('maxOpticalDepth'),
  };
}

export type CloudShadowQuery =
  | { readonly covered: true; readonly opticalDepth: number; readonly transmittance: number }
  | { readonly covered: false; readonly fallback: 'secondary-ray' | 'unshadowed-surface' };

export function queryCloudShadow(
  sample: CloudShadowSample | undefined,
  depthMeters: number,
  receiver: 'cloud' | 'surface',
): CloudShadowQuery {
  if (!sample)
    return {
      covered: false,
      fallback: receiver === 'cloud' ? 'secondary-ray' : 'unshadowed-surface',
    };
  const opticalDepth = cloudShadowOpticalDepth(sample, depthMeters);
  return { covered: true, opticalDepth, transmittance: Math.exp(-opticalDepth) };
}

export interface CookedCloudShadow {
  readonly lightDistanceMeters?: number;
  readonly directionToLight: CloudRgb;
  readonly origin: CloudRgb;
  readonly right: CloudRgb;
  readonly up: CloudRgb;
  readonly extentMeters: number;
  readonly depthMeters: number;
  readonly resolution: number;
  readonly mapSamples: number;
  readonly ue5Reference?: boolean;
  readonly spatialPasses?: number;
  /** Resolved floating-point midpoint budget for this view. */
  readonly traceSamples?: number;
  readonly mode: number;
  readonly cast: boolean;
  readonly biasMeters: number;
  readonly strength: number;
  readonly surfaceStrength: number;
  readonly atmosphereStrength?: number;
}

export type CloudShadowSettings = Omit<
  CookedCloudShadow,
  'origin' | 'right' | 'up' | 'traceSamples'
>;
export const CLOUD_BSM_LIGHT_DISTANCE_METERS = 300_000;

/** View-owned UE projection: ground anchor, independent light distance and finite depth. */
export function viewCloudShadowProjection(
  input: CloudShadowSettings,
  cameraPosition: ArrayLike<number>,
): CookedCloudShadow {
  const lightDistanceMeters = input.lightDistanceMeters ?? CLOUD_BSM_LIGHT_DISTANCE_METERS;
  const radius = 6_360_000;
  const radial = normalize([
    cameraPosition[0] ?? 0,
    (cameraPosition[1] ?? 0) + radius,
    cameraPosition[2] ?? 0,
  ]);
  const ground: CloudRgb = [radial[0] * radius, radial[1] * radius - radius, radial[2] * radius];
  const snapWorld = (meters: number) => Math.floor(meters / 20_000 + 0.5) * 20_000;
  const anchor: CloudRgb = input.ue5Reference
    ? [snapWorld(ground[0]), snapWorld(ground[1]), snapWorld(ground[2])]
    : ground;
  const projection = createCloudShadowProjection({
    center: anchor,
    ...(input.ue5Reference
      ? {
          verticalBasisThreshold: 0.99,
          snapTexelSize: (2 * input.extentMeters) / input.resolution,
        }
      : {}),
    sunDirection: input.directionToLight,
    range: input.extentMeters,
    resolution: cloudShadowSpatialLayout(input.resolution, input.spatialPasses, input.ue5Reference)
      .filteredResolution,
  });
  return {
    ...input,
    ...(input.ue5Reference
      ? {
          traceSamples: ue5CloudShadowTraceSamples(
            input.mapSamples,
            dot(radial, projection.sunDirection),
          ),
        }
      : {}),
    directionToLight: projection.sunDirection,
    right: projection.right,
    up: projection.up,
    origin: [
      projection.origin[0] + projection.sunDirection[0] * lightDistanceMeters,
      projection.origin[1] + projection.sunDirection[1] * lightDistanceMeters,
      projection.origin[2] + projection.sunDirection[2] * lightDistanceMeters,
    ],
  };
}

/** One detached projection feeds map production, cloud queries and ground queries. */
export function cookedCloudShadowProjection(
  input: Omit<CookedCloudShadow, 'origin' | 'right' | 'up' | 'traceSamples'>,
  bottomMeters: number,
  thicknessMeters: number,
): CookedCloudShadow {
  const center = [0, bottomMeters + thicknessMeters * 0.5, 0] as const;
  const projection = createCloudShadowProjection({
    center,
    sunDirection: input.directionToLight,
    range: input.extentMeters,
    resolution: input.resolution,
  });
  // The sampled-cloud geometry uses this same planet at world (0, -radius, 0).
  const planetRadiusMeters = 6_360_000;
  const innerRadius = planetRadiusMeters + bottomMeters;
  const outerRadius = innerRadius + thicknessMeters;
  const planetRelative: CloudRgb = [
    -projection.origin[0],
    -planetRadiusMeters - projection.origin[1],
    -projection.origin[2],
  ];
  const halfExtent = projection.range * 0.5;
  const x = Math.abs(dot(planetRelative, projection.right));
  const y = Math.abs(dot(planetRelative, projection.up));
  // Distance extrema over the whole rectangle, including an interior nearest point.
  const nearestRadius = Math.hypot(Math.max(0, x - halfExtent), Math.max(0, y - halfExtent));
  const farthestRadius = Math.hypot(x + halfExtent, y + halfExtent);
  // Bound f32 basis/origin packing and near-plane reconstruction in meters.
  // Expand lateral bounds too: rounding across the inner tangent changes the
  // first interval's far endpoint discontinuously to the outer back surface.
  const packingMargin =
    8 * 2 ** -23 * Math.max(outerRadius, halfExtent, Math.hypot(...projection.origin));
  const nearestBound = Math.max(0, nearestRadius - packingMargin);
  const farthestBound = farthestRadius + packingMargin;
  let near = input.depthMeters * 0.5;
  let depthMeters = input.depthMeters;
  if (nearestBound < outerRadius) {
    const sphereHeight = (radius: number, lateral: number) =>
      Math.sqrt(Math.max(0, (radius - lateral) * (radius + lateral)));
    const axis = dot(planetRelative, projection.sunDirection);
    const nearSurface = sphereHeight(outerRadius, nearestBound);
    // A ray hitting the inner sphere stops at its front surface. At/above its
    // tangent it instead crosses the outer sphere: the far extremum can lie
    // inside the rectangle at lateral radius innerRadius, not at a corner.
    const farSurface =
      farthestBound < innerRadius
        ? sphereHeight(innerRadius, farthestBound)
        : -sphereHeight(outerRadius, Math.max(innerRadius, nearestBound));
    near = axis + nearSurface + packingMargin;
    depthMeters = Math.max(input.depthMeters, nearSurface - farSurface + 2 * packingMargin);
  }
  return {
    ...input,
    depthMeters,
    directionToLight: projection.sunDirection,
    right: projection.right,
    up: projection.up,
    origin: [
      projection.origin[0] + projection.sunDirection[0] * near,
      projection.origin[1] + projection.sunDirection[1] * near,
      projection.origin[2] + projection.sunDirection[2] * near,
    ],
  };
}

export interface CloudLightSettings {
  readonly directionToLight: CloudRgb;
  readonly illuminance: CloudRgb;
  readonly selfShadow: 'raymarch' | 'beer-map';
  readonly castCloudShadows: boolean;
  readonly shadowExtentMeters: number;
  readonly shadowDepthBiasMeters: number;
  readonly shadowTracingDistanceMeters: number;
  readonly shadowViewSampleCountScale: number;
  readonly shadowMapSampleScale: number;
  readonly shadowResolutionScale: number;
  readonly shadowStrength: number;
  readonly surfaceShadowStrength: number;
  readonly atmosphereShadowStrength: number;
}

export type CloudLightPreparation =
  | {
      readonly ok: true;
      readonly settings: CloudLightSettings;
      readonly requiresShadowMap: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'missing-sun' | 'invalid-light-settings';
      readonly field: string;
    };

/** Validate the actual primary sun; no synthetic light or white-map fallback. */
export function prepareCloudLight(settings: CloudLightSettings | undefined): CloudLightPreparation {
  if (!settings) return { ok: false, reason: 'missing-sun', field: 'sun' };
  const directionLength = Math.hypot(...settings.directionToLight);
  if (!Number.isFinite(directionLength) || directionLength === 0)
    return { ok: false, reason: 'invalid-light-settings', field: 'directionToLight' };
  for (const value of settings.illuminance) {
    if (!Number.isFinite(value) || value < 0)
      return { ok: false, reason: 'invalid-light-settings', field: 'illuminance' };
  }
  const positive = [
    'shadowExtentMeters',
    'shadowViewSampleCountScale',
    'shadowMapSampleScale',
    'shadowResolutionScale',
  ] as const;
  const nonnegative = [
    'shadowTracingDistanceMeters',
    'shadowStrength',
    'surfaceShadowStrength',
    'atmosphereShadowStrength',
  ] as const;
  for (const field of positive)
    if (!Number.isFinite(settings[field]) || settings[field] <= 0)
      return { ok: false, reason: 'invalid-light-settings', field };
  for (const field of nonnegative)
    if (!Number.isFinite(settings[field]) || settings[field] < 0)
      return { ok: false, reason: 'invalid-light-settings', field };
  if (!Number.isFinite(settings.shadowDepthBiasMeters))
    return { ok: false, reason: 'invalid-light-settings', field: 'shadowDepthBiasMeters' };
  return {
    ok: true,
    settings: {
      ...settings,
      directionToLight: [
        settings.directionToLight[0] / directionLength,
        settings.directionToLight[1] / directionLength,
        settings.directionToLight[2] / directionLength,
      ],
    },
    requiresShadowMap: settings.selfShadow === 'beer-map' || settings.castCloudShadows,
  };
}

export function cloudConsumerShadow(transmittance: number, strength: number): number {
  return 1 + (transmittance - 1) * Math.min(1, Math.max(0, strength));
}
