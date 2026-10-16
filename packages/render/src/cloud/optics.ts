import type { CloudDensityCache } from './density';
import { evaluateCloudDensity, sampleCloudDensity } from './density';
import { CLOUD_EXTINCTION_COEFFICIENT, type ValidatedCloudLayer } from './parameters';

export type CloudOpticalPath = 'camera' | 'solar-column' | 'cloud-interior';

export interface CloudRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly maxDistance: number;
}

export interface CloudOpticalResult {
  readonly path: CloudOpticalPath;
  readonly transmittance: number;
  readonly scattering: readonly [number, number, number];
  readonly opticalDepth: number;
  readonly representativeDepth: number;
  readonly steps: number;
  readonly entered: boolean;
  readonly exited: boolean;
}

export interface CloudInteriorLighting {
  readonly sunRadiance: readonly [number, number, number];
  readonly sunDirection: readonly [number, number, number];
  readonly phaseG?: number;
}

export interface CloudOpticsInput {
  readonly params: ValidatedCloudLayer;
  readonly ray: CloudRay;
  readonly path: CloudOpticalPath;
  readonly timeSeconds?: number;
  readonly cache?: CloudDensityCache;
  readonly steps?: number;
  readonly lighting?: CloudInteriorLighting;
}

const EMPTY_SCATTERING: readonly [number, number, number] = [0, 0, 0];

function normalize(vector: ArrayLike<number>): readonly [number, number, number] {
  const x = vector[0] ?? 0;
  const y = vector[1] ?? 0;
  const z = vector[2] ?? 0;
  const length = Math.hypot(x, y, z);
  return length <= 1e-8 ? [0, 1, 0] : [x / length, y / length, z / length];
}

function rayBoxInterval(
  ray: CloudRay,
  params: ValidatedCloudLayer,
): { readonly start: number; readonly end: number } | undefined {
  const min = [Number.NEGATIVE_INFINITY, params.baseHeight, Number.NEGATIVE_INFINITY];
  const max = [
    Number.POSITIVE_INFINITY,
    params.baseHeight + params.thickness,
    Number.POSITIVE_INFINITY,
  ];
  let start = 0;
  let end = Math.max(0, ray.maxDistance);
  for (let axis = 0; axis < 3; axis += 1) {
    const origin = ray.origin[axis] ?? 0;
    const direction = ray.direction[axis] ?? 0;
    const lower = min[axis] ?? 0;
    const upper = max[axis] ?? 0;
    if (Math.abs(direction) < 1e-8) {
      if (origin < lower || origin > upper) return undefined;
      continue;
    }
    const a = (lower - origin) / direction;
    const b = (upper - origin) / direction;
    start = Math.max(start, Math.min(a, b));
    end = Math.min(end, Math.max(a, b));
    if (end <= start) return undefined;
  }
  return end > start ? { start, end } : undefined;
}

export function intersectCloudLayer(
  ray: CloudRay,
  params: ValidatedCloudLayer,
): { readonly start: number; readonly end: number } | undefined {
  return rayBoxInterval(ray, params);
}

function phaseFunction(cosTheta: number, g: number): number {
  const boundedG = Math.max(-0.95, Math.min(0.95, g));
  const denominator = Math.max(1e-4, 1 + boundedG * boundedG - 2 * boundedG * cosTheta);
  return ((1 - boundedG * boundedG) / denominator ** 1.5) * (1 / (4 * Math.PI));
}

function cloudPhase(cosTheta: number, forwardG: number): number {
  // Match the bounded dual-lobe phase used by the fullscreen WGSL path.
  return phaseFunction(cosTheta, forwardG) * 0.8 + phaseFunction(cosTheta, -0.2) * 0.2;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Unit-sun incident light, using the same phase basis as production volumes. */
export function cloudIncidentLight(
  solarT: number,
  cosTheta: number,
  height: number,
  forwardG = 0.55,
): readonly [number, number, number] {
  const direct = solarT * cloudPhase(cosTheta, forwardG);
  const multiple = (0.5 * Math.sqrt(solarT) + 0.25 * solarT ** 0.25) / (4 * Math.PI);
  const energy = (direct + multiple) * (4 * Math.PI);
  const skyFill = 0.025 + 0.05 * smoothstep(0.1, 0.85, height);
  return [energy + 0.72 * skyFill, energy + 0.84 * skyFill, energy + skyFill];
}

function densityAt(input: CloudOpticsInput, position: readonly [number, number, number]): number {
  return input.cache === undefined
    ? evaluateCloudDensity(input.params, position, input.timeSeconds ?? 0).density
    : sampleCloudDensity(input.cache, input.params, position, input.timeSeconds ?? 0);
}

/**
 * Integrate one explicitly named optical path through the layer.
 *
 * Camera, solar-column and cloud-interior paths are intentionally separate
 * call sites. A caller cannot accidentally use a camera interval as the
 * light interval and apply the same cloud attenuation twice.
 */
export function integrateCloudPath(input: CloudOpticsInput): CloudOpticalResult {
  const direction = normalize(input.ray.direction);
  const interval = rayBoxInterval({ ...input.ray, direction }, input.params);
  if (interval === undefined || input.params.density <= 0) {
    return {
      path: input.path,
      transmittance: 1,
      scattering: EMPTY_SCATTERING,
      opticalDepth: 0,
      representativeDepth: input.ray.maxDistance,
      steps: 0,
      entered: false,
      exited: false,
    };
  }
  const steps = Math.max(1, Math.floor(input.steps ?? 32));
  const length = interval.end - interval.start;
  const stepLength = length / steps;
  let opticalDepth = 0;
  const scattering: [number, number, number] = [0, 0, 0];
  let weightedDepth = 0;
  let scatteringWeight = 0;
  const lighting = input.lighting;
  const lightDirection = lighting === undefined ? undefined : normalize(lighting.sunDirection);
  const viewDirection = normalize(input.ray.direction);
  for (let index = 0; index < steps; index += 1) {
    const distance = interval.start + (index + 0.5) * stepLength;
    const position: [number, number, number] = [
      (input.ray.origin[0] ?? 0) + direction[0] * distance,
      (input.ray.origin[1] ?? 0) + direction[1] * distance,
      (input.ray.origin[2] ?? 0) + direction[2] * distance,
    ];
    const localDensity = Math.max(0, densityAt(input, position));
    const extinction = localDensity * CLOUD_EXTINCTION_COEFFICIENT * stepLength;
    const transmittanceBefore = Math.exp(-opticalDepth);
    opticalDepth += extinction;
    if (lighting !== undefined && lightDirection !== undefined && localDensity > 0) {
      const localShadow = integrateCloudPath({
        params: input.params,
        path: 'solar-column',
        ray: {
          origin: position,
          direction: lightDirection,
          maxDistance: input.params.shadowRange,
        },
        steps: Math.max(4, Math.ceil((input.steps ?? 32) * 0.5)),
        ...(input.timeSeconds === undefined ? {} : { timeSeconds: input.timeSeconds }),
        ...(input.cache === undefined ? {} : { cache: input.cache }),
      });
      const cosTheta =
        viewDirection[0] * lightDirection[0] +
        viewDirection[1] * lightDirection[1] +
        viewDirection[2] * lightDirection[2];
      const segmentWeight = transmittanceBefore * (1 - Math.exp(-extinction));
      const heightFraction = Math.max(
        0,
        Math.min(1, ((position[1] ?? 0) - input.params.baseHeight) / input.params.thickness),
      );
      const incident = cloudIncidentLight(
        localShadow.transmittance,
        cosTheta,
        heightFraction,
        lighting.phaseG,
      );
      for (let channel = 0; channel < 3; channel++) {
        scattering[channel] =
          (scattering[channel] ?? 0) +
          (lighting.sunRadiance[channel] ?? 0) * (incident[channel] ?? 0) * segmentWeight;
      }
      const weight = segmentWeight;
      scatteringWeight += weight;
      weightedDepth += distance * weight;
    }
  }
  const transmittance = Math.exp(-opticalDepth);
  return {
    path: input.path,
    transmittance,
    scattering,
    opticalDepth,
    representativeDepth:
      scatteringWeight > 1e-6 ? weightedDepth / scatteringWeight : interval.start,
    steps,
    entered: true,
    exited: interval.end < input.ray.maxDistance,
  };
}

export function integrateCloudCameraPath(
  params: ValidatedCloudLayer,
  ray: CloudRay,
  options: Omit<CloudOpticsInput, 'params' | 'ray' | 'path'> = {},
): CloudOpticalResult {
  return integrateCloudPath({ ...options, params, ray, path: 'camera' });
}

export function integrateCloudSolarColumn(
  params: ValidatedCloudLayer,
  origin: readonly [number, number, number],
  sunDirection: readonly [number, number, number],
  options: Omit<CloudOpticsInput, 'params' | 'ray' | 'path'> & {
    readonly maxDistance?: number;
  } = {},
): CloudOpticalResult {
  return integrateCloudPath({
    ...options,
    params,
    path: 'solar-column',
    ray: {
      origin,
      direction: sunDirection,
      maxDistance: options.maxDistance ?? params.shadowRange,
    },
  });
}

export function integrateCloudInterior(
  params: ValidatedCloudLayer,
  ray: CloudRay,
  lighting: CloudInteriorLighting,
  options: Omit<CloudOpticsInput, 'params' | 'ray' | 'path' | 'lighting'> = {},
): CloudOpticalResult {
  return integrateCloudPath({ ...options, params, ray, path: 'cloud-interior', lighting });
}

/** Standard's one selected sun term consumes this factor exactly once. */
export function applyCloudSolarTransmittance(
  directSunRadiance: readonly [number, number, number],
  cloudTransmittance: number,
  meshVisibility = 1,
): readonly [number, number, number] {
  const factor =
    Math.min(1, Math.max(0, cloudTransmittance)) * Math.min(1, Math.max(0, meshVisibility));
  return [
    (directSunRadiance[0] ?? 0) * factor,
    (directSunRadiance[1] ?? 0) * factor,
    (directSunRadiance[2] ?? 0) * factor,
  ];
}

/** Scene-linear HDR composition at the cloud interval/depth boundary. */
export function compositeCloudRadiance(
  sceneLinearHdr: readonly [number, number, number, number],
  cloud: CloudOpticalResult,
  sceneDepth: number,
  cloudDepth = cloud.representativeDepth,
): readonly [number, number, number, number] {
  if (!Number.isFinite(sceneDepth) || cloudDepth > sceneDepth) return sceneLinearHdr;
  const transmittance = Math.min(1, Math.max(0, cloud.transmittance));
  return [
    (sceneLinearHdr[0] ?? 0) * transmittance + (cloud.scattering[0] ?? 0),
    (sceneLinearHdr[1] ?? 0) * transmittance + (cloud.scattering[1] ?? 0),
    (sceneLinearHdr[2] ?? 0) * transmittance + (cloud.scattering[2] ?? 0),
    1,
  ];
}
