import { type Color3, fresnelReflectance, type Uv2 } from './oracle.js';

export type MediumVector3 = readonly [number, number, number];

export interface SingleLayerMediumCoefficients {
  /** Linear, inverse-metre absorption coefficients. */
  readonly absorption: MediumVector3;
  /** Linear, inverse-metre scattering coefficients. */
  readonly scattering: MediumVector3;
  readonly ior: number;
  /** Henyey-Greenstein phase anisotropy in [-1, 1]. */
  readonly phaseG?: number;
}

export interface SingleLayerMediumOptics {
  readonly sigmaT: MediumVector3;
  readonly transmittance: MediumVector3;
  /** Uniform-medium single-scatter integral sigmaS * (1 - T) / sigmaT. */
  readonly singleScatter: MediumVector3;
  readonly reflectance: number;
  readonly transmissionWeight: number;
  readonly phase: number;
  readonly distanceMeters: number;
}

export type SingleLayerMediumBackgroundReason = 'front' | 'shore' | 'edge' | 'sky-miss';

export interface SingleLayerMediumBackgroundCandidate {
  readonly color: Color3;
  readonly depthMeters: number;
  readonly uv: Uv2;
}

export interface SingleLayerMediumBackgroundInput {
  /** No-water color and raw depth must come from the same view identity. */
  readonly original: SingleLayerMediumBackgroundCandidate;
  /** Refracted candidate carries color and depth as one pair. */
  readonly refracted?: SingleLayerMediumBackgroundCandidate;
  readonly environment?: Color3;
  readonly surfaceDepthMeters: number;
  readonly maxDistanceMeters: number;
  readonly depthToleranceMeters?: number;
}

export interface SingleLayerMediumBackgroundResolution {
  readonly source: 'refracted' | 'unrefracted' | 'environment';
  readonly reason?: SingleLayerMediumBackgroundReason;
  readonly candidate: SingleLayerMediumBackgroundCandidate | undefined;
  readonly color: Color3;
  readonly distanceMeters: number;
}

const DEFAULT_MAX_DISTANCE_METERS = 1000;
const DEFAULT_DEPTH_TOLERANCE_METERS = 0.001;
const DEFAULT_IOR = 1.333;

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

function oneMinusExpNeg(value: number): number {
  const x = Math.max(finiteOr(value, 0), 0);
  if (x < 1e-3) {
    const x2 = x * x;
    return x * (1 - x * 0.5 + x2 / 6 - (x * x2) / 24);
  }
  return -Math.expm1(-x);
}

function singleScatterIntegral(sigmaS: number, sigmaT: number, distance: number): number {
  const scattering = Math.max(finiteOr(sigmaS, 0), 0);
  const extinction = Math.max(finiteOr(sigmaT, 0), 0);
  const path = Math.max(finiteOr(distance, 0), 0);
  if (extinction === 0) return scattering * path;
  return (scattering * oneMinusExpNeg(extinction * path)) / extinction;
}

const nonNegative = (value: number): number => Math.max(finiteOr(value, 0), 0);

const clamp01 = (value: number): number => Math.min(Math.max(finiteOr(value, 0), 0), 1);

function vector3(input: MediumVector3 | undefined): MediumVector3 {
  return [nonNegative(input?.[0] ?? 0), nonNegative(input?.[1] ?? 0), nonNegative(input?.[2] ?? 0)];
}

function finiteColor(input: Color3 | undefined): input is Color3 {
  return input !== undefined && input.length === 3 && input.every(Number.isFinite);
}

function finiteUv(input: Uv2): boolean {
  return input.length === 2 && input.every(Number.isFinite);
}

function safeDistance(value: number, maxDistance: number): number {
  return Math.min(Math.max(finiteOr(value, 0), 0), maxDistance);
}

/**
 * Evaluate the stable analytic portion of the Engine's single-layer model.
 * Zero extinction uses the continuous limit and every returned component is
 * finite, even when an authored value is NaN or infinite.
 */
export function integrateSingleLayerMedium(input: {
  readonly coefficients: SingleLayerMediumCoefficients;
  readonly distanceMeters: number;
  readonly cosTheta: number;
  readonly phaseCosTheta?: number;
  /** Finite authored propagation bound; defaults to the conservative 1000 m bound. */
  readonly maxDistanceMeters?: number;
}): SingleLayerMediumOptics {
  const absorption = vector3(input.coefficients.absorption);
  const scattering = vector3(input.coefficients.scattering);
  const sigmaT: MediumVector3 = [
    absorption[0] + scattering[0],
    absorption[1] + scattering[1],
    absorption[2] + scattering[2],
  ];
  const maxDistanceMeters = Math.min(
    Math.max(
      finiteOr(input.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_METERS, DEFAULT_MAX_DISTANCE_METERS),
      0,
    ),
    100000,
  );
  const distanceMeters = safeDistance(input.distanceMeters, maxDistanceMeters);
  const transmittance: MediumVector3 = [
    Number.isFinite(sigmaT[0]) && sigmaT[0] > 0 ? Math.exp(-sigmaT[0] * distanceMeters) : 1,
    Number.isFinite(sigmaT[1]) && sigmaT[1] > 0 ? Math.exp(-sigmaT[1] * distanceMeters) : 1,
    Number.isFinite(sigmaT[2]) && sigmaT[2] > 0 ? Math.exp(-sigmaT[2] * distanceMeters) : 1,
  ];
  const singleScatter: MediumVector3 = [
    singleScatterIntegral(scattering[0], sigmaT[0], distanceMeters),
    singleScatterIntegral(scattering[1], sigmaT[1], distanceMeters),
    singleScatterIntegral(scattering[2], sigmaT[2], distanceMeters),
  ];
  const iorCandidate = finiteOr(input.coefficients.ior, DEFAULT_IOR);
  const ior = iorCandidate >= 1 ? iorCandidate : DEFAULT_IOR;
  const reflectance = fresnelReflectance(input.cosTheta, 1 / ior);
  const transmissionWeight = 1 - reflectance;
  const phaseG = Math.min(Math.max(finiteOr(input.coefficients.phaseG ?? 0, 0), -1), 1);
  const phaseCosTheta = clamp01(input.phaseCosTheta ?? input.cosTheta);
  const phaseDenominator = Math.max(1 + phaseG * phaseG - 2 * phaseG * phaseCosTheta, 1e-6);
  const phase = (1 - phaseG * phaseG) / (4 * Math.PI * phaseDenominator ** 1.5);
  return {
    sigmaT,
    transmittance,
    singleScatter,
    reflectance,
    transmissionWeight,
    phase: finiteOr(phase, 1 / (4 * Math.PI)),
    distanceMeters,
  };
}

/** Compose linear HDR terms after exactly one Fresnel allocation. */
export function composeSingleLayerMediumColor(input: {
  readonly optics: SingleLayerMediumOptics;
  readonly background: Color3;
  readonly reflection: Color3;
  readonly foamColor?: Color3;
  readonly coverage?: number;
  readonly foam?: number;
}): Color3 {
  const coverage = clamp01(input.coverage ?? 1);
  const foam = clamp01(input.foam ?? 0) * coverage;
  const foamColor = finiteColor(input.foamColor) ? input.foamColor : [1, 1, 1];
  const background = finiteColor(input.background) ? input.background : [0, 0, 0];
  const reflection = finiteColor(input.reflection) ? input.reflection : [0, 0, 0];
  const medium: MediumVector3 = [
    background[0] * input.optics.transmittance[0] + input.optics.singleScatter[0],
    background[1] * input.optics.transmittance[1] + input.optics.singleScatter[1],
    background[2] * input.optics.transmittance[2] + input.optics.singleScatter[2],
  ];
  const waterWeight = input.optics.transmissionWeight * coverage * (1 - foam);
  const reflectionWeight = input.optics.reflectance * coverage;
  const foamWeight = foam;
  return [
    finiteOr(
      reflection[0] * reflectionWeight + medium[0] * waterWeight + foamColor[0] * foamWeight,
      0,
    ),
    finiteOr(
      reflection[1] * reflectionWeight + medium[1] * waterWeight + foamColor[1] * foamWeight,
      0,
    ),
    finiteOr(
      reflection[2] * reflectionWeight + medium[2] * waterWeight + foamColor[2] * foamWeight,
      0,
    ),
  ];
}

function validCandidate(
  candidate: SingleLayerMediumBackgroundCandidate | undefined,
  maxDistance: number,
): candidate is SingleLayerMediumBackgroundCandidate {
  return (
    candidate !== undefined &&
    finiteColor(candidate.color) &&
    finiteUv(candidate.uv) &&
    Number.isFinite(candidate.depthMeters) &&
    candidate.depthMeters >= 0 &&
    candidate.depthMeters <= maxDistance
  );
}

/**
 * Resolve paired color/depth input with front, shore, edge, and sky-miss
 * reasons. Environment is a reflection/background fallback only; it is never
 * used as a riverbed transmission sample when a valid original pair exists.
 */
export function resolveSingleLayerMediumBackground(
  input: SingleLayerMediumBackgroundInput,
): SingleLayerMediumBackgroundResolution {
  const maxDistance = Math.max(finiteOr(input.maxDistanceMeters, DEFAULT_MAX_DISTANCE_METERS), 0);
  const tolerance = Math.max(
    finiteOr(
      input.depthToleranceMeters ?? DEFAULT_DEPTH_TOLERANCE_METERS,
      DEFAULT_DEPTH_TOLERANCE_METERS,
    ),
    0,
  );
  const surfaceDepth = finiteOr(input.surfaceDepthMeters, 0);
  if (
    validCandidate(input.refracted, maxDistance) &&
    input.refracted.uv.every((coordinate) => coordinate >= 0 && coordinate <= 1)
  ) {
    if (input.refracted.depthMeters + tolerance < surfaceDepth) {
      return {
        source: 'unrefracted',
        reason: 'front',
        candidate: validCandidate(input.original, maxDistance) ? input.original : undefined,
        color: validCandidate(input.original, maxDistance) ? input.original.color : [0, 0, 0],
        distanceMeters: validCandidate(input.original, maxDistance)
          ? Math.max(input.original.depthMeters - surfaceDepth, 0)
          : 0,
      };
    }
    return {
      source: 'refracted',
      candidate: input.refracted,
      color: input.refracted.color,
      distanceMeters: Math.max(input.refracted.depthMeters - surfaceDepth, 0),
    };
  }
  if (validCandidate(input.original, maxDistance)) {
    const reason: SingleLayerMediumBackgroundReason =
      input.refracted === undefined
        ? 'shore'
        : finiteUv(input.refracted.uv) &&
            input.refracted.uv.some((coordinate) => coordinate < 0 || coordinate > 1)
          ? 'edge'
          : 'shore';
    return {
      source: 'unrefracted',
      reason,
      candidate: input.original,
      color: input.original.color,
      distanceMeters: Math.max(input.original.depthMeters - surfaceDepth, 0),
    };
  }
  if (finiteColor(input.environment)) {
    return {
      source: 'environment',
      reason: 'sky-miss',
      candidate: undefined,
      color: input.environment,
      distanceMeters: maxDistance,
    };
  }
  return {
    source: 'environment',
    reason: 'sky-miss',
    candidate: undefined,
    color: [0, 0, 0],
    distanceMeters: maxDistance,
  };
}

/** Screen-space approximation of the Euclidean endpoint path, clamped to the declared maximum. */
export function estimateSingleLayerPathLength(input: {
  readonly surfacePosition: readonly [number, number, number];
  readonly backgroundPosition: readonly [number, number, number] | undefined;
  readonly maxDistanceMeters: number;
}): { readonly distanceMeters: number; readonly valid: boolean } {
  const maxDistance = Math.max(finiteOr(input.maxDistanceMeters, DEFAULT_MAX_DISTANCE_METERS), 0);
  if (
    input.surfacePosition.length !== 3 ||
    input.backgroundPosition === undefined ||
    input.backgroundPosition.length !== 3 ||
    !input.surfacePosition.every(Number.isFinite) ||
    !input.backgroundPosition.every(Number.isFinite)
  ) {
    return { distanceMeters: maxDistance, valid: false };
  }
  const distance = Math.hypot(
    (input.backgroundPosition[0] ?? 0) - (input.surfacePosition[0] ?? 0),
    (input.backgroundPosition[1] ?? 0) - (input.surfacePosition[1] ?? 0),
    (input.backgroundPosition[2] ?? 0) - (input.surfacePosition[2] ?? 0),
  );
  return {
    distanceMeters: Math.min(Math.max(finiteOr(distance, maxDistance), 0), maxDistance),
    valid: Number.isFinite(distance),
  };
}
