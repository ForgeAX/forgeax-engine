import type { CloudRgb, MediumSample } from '../contracts';
import { type ConservativeDensity, evaluateUniformMedium } from '../density/medium';
import {
  CLOUD_UNTRACED_DEPTH_METERS,
  type CloudInterval,
  type CloudRay,
  type CloudShell,
  type CloudTraceClip,
  cloudShellInterval,
} from './geometry';
import { CLOUD_SAMPLED_MAX_STEPS, cloudViewSampling } from './policy';

export interface CloudSegmentTransfer {
  readonly radiance: CloudRgb;
  readonly transmittance: number;
}

export interface CloudTraceResult extends CloudSegmentTransfer, CloudInterval {
  readonly sceneDepthMeters: number;
  readonly representativeDepthMeters: number;
}

/** Integrates one uniform segment, with incident radiance already phase-weighted. */
export function cloudSegmentTransfer(
  sample: MediumSample,
  scatterRadiance: CloudRgb,
  distanceMeters: number,
): CloudSegmentTransfer {
  const opticalDepth = sample.extinctionPerMeter * distanceMeters;
  const transmittance = Math.exp(-opticalDepth);
  const removed = -Math.expm1(-opticalDepth);
  const emissionLength =
    opticalDepth > 0 ? distanceMeters * (removed / opticalDepth) : distanceMeters;
  return {
    radiance: [
      sample.albedo[0] * scatterRadiance[0] * removed + sample.emissivePerMeter[0] * emissionLength,
      sample.albedo[1] * scatterRadiance[1] * removed + sample.emissivePerMeter[1] * emissionLength,
      sample.albedo[2] * scatterRadiance[2] * removed + sample.emissivePerMeter[2] * emissionLength,
    ],
    transmittance,
  };
}

function untracedCloud(sceneDepthMeters: number): CloudTraceResult {
  return {
    radiance: [0, 0, 0],
    transmittance: 1,
    entryMeters: CLOUD_UNTRACED_DEPTH_METERS,
    exitMeters: CLOUD_UNTRACED_DEPTH_METERS,
    sceneDepthMeters,
    representativeDepthMeters: CLOUD_UNTRACED_DEPTH_METERS,
  };
}

export function traceUniformCloud(
  ray: CloudRay,
  shell: CloudShell,
  clip: CloudTraceClip,
  sample: MediumSample,
  scatterRadiance: CloudRgb,
): CloudTraceResult {
  const interval = cloudShellInterval(ray, shell, clip);
  const sceneDepthMeters = clip.sceneDistanceMeters;
  if (interval === undefined) return untracedCloud(sceneDepthMeters);
  const medium = evaluateUniformMedium(sample, 0.5);
  const lengthMeters = interval.exitMeters - interval.entryMeters;
  const transfer = cloudSegmentTransfer(medium, scatterRadiance, lengthMeters);
  const opticalDepth = medium.extinctionPerMeter * lengthMeters;
  const representativeDepthMeters =
    transfer.transmittance > 0.99
      ? interval.exitMeters
      : interval.entryMeters + lengthMeters * (1 / opticalDepth - 1 / Math.expm1(opticalDepth));
  return { ...interval, ...transfer, sceneDepthMeters, representativeDepthMeters };
}

export interface CloudSampledTraceOptions {
  /** Near depth of the reduced footprint; the clip carries the far depth. */
  readonly nearSceneDistanceMeters?: number;
  readonly distanceToMaxSamplesMeters: number;
  readonly minSamples: number;
  readonly maxSamples: number;
  readonly loopCap: number;
  readonly skipEmpty: boolean;
  readonly stopTransmittance?: number;
  readonly samplePhase?: number;
}

export interface CloudSampledEvaluator {
  /** C4.x may only be nonpositive when the full sample is vacuum. */
  conservative(distanceMeters: number): ConservativeDensity;
  medium(distanceMeters: number, c4: ConservativeDensity): MediumSample;
}

export interface CloudSampledTraceResult {
  readonly trace: CloudTraceResult;
  readonly near: CloudSegmentTransfer;
  readonly nearRepresentativeDepthMeters: number;
  readonly c4: ConservativeDensity;
  readonly extinctionPerMeter: number;
  readonly witnessDistanceMeters: number;
  /** Evaluated budget, traversed samples, full evaluator calls, occupied samples. */
  readonly counts: readonly [number, number, number, number];
  readonly opticalDepth: number;
}

function isCloudTraceComplete(transmittance: number, stopTransmittance: number): boolean {
  return stopTransmittance > 0 && transmittance < stopTransmittance;
}

function publishCloudTransmittance(transmittance: number, stopTransmittance: number): number {
  return isCloudTraceComplete(transmittance, stopTransmittance) ? 0 : transmittance;
}

function meanCloudDepth(
  transmittance: number,
  exitMeters: number,
  weightSum: number,
  weightedDepth: number,
): number {
  return transmittance > 0.99 || weightSum === 0 ? exitMeters : weightedDepth / weightSum;
}

function meanNearCloudDepth(
  interval: CloudInterval,
  nearDepth: number,
  weightSum: number,
  weightedDepth: number,
): number {
  return weightSum > 0 ? weightedDepth / weightSum : Math.min(interval.exitMeters, nearDepth);
}

function untracedSampledCloud(sceneDepthMeters: number): CloudSampledTraceResult {
  return {
    trace: untracedCloud(sceneDepthMeters),
    near: { radiance: [0, 0, 0], transmittance: 1 },
    nearRepresentativeDepthMeters: CLOUD_UNTRACED_DEPTH_METERS,
    c4: [0, 0, 0, 0],
    extinctionPerMeter: 0,
    witnessDistanceMeters: CLOUD_UNTRACED_DEPTH_METERS,
    counts: [0, 0, 0, 0],
    opticalDepth: 0,
  };
}

/** CPU reference for the R3 midpoint march, including its observable skip branch. */
export function traceSampledCloud(
  ray: CloudRay,
  shell: CloudShell,
  clip: CloudTraceClip,
  options: CloudSampledTraceOptions,
  evaluate: CloudSampledEvaluator,
  scatterRadiance: CloudRgb,
): CloudSampledTraceResult {
  const interval = cloudShellInterval(ray, shell, clip);
  const sceneDepthMeters = clip.sceneDistanceMeters;
  if (interval === undefined) return untracedSampledCloud(sceneDepthMeters);
  const nearDepth = options.nearSceneDistanceMeters ?? sceneDepthMeters;
  const samplePhase = options.samplePhase ?? 0.5;
  const stopTransmittance = options.stopTransmittance ?? 0;
  let c4: ConservativeDensity = [0, 0, 0, 0];
  let extinctionPerMeter = 0;
  let witnessDistanceMeters = CLOUD_UNTRACED_DEPTH_METERS;
  let opticalDepth = 0;
  const radiance: [number, number, number] = [0, 0, 0];
  const nearRadiance: [number, number, number] = [0, 0, 0];
  let nearTransmittance = 1;
  let transmittance = 1;
  const sampling = cloudViewSampling(
    interval.exitMeters - interval.entryMeters,
    options.minSamples,
    options.maxSamples,
    options.distanceToMaxSamplesMeters,
    Math.min(options.loopCap, CLOUD_SAMPLED_MAX_STEPS),
  );
  let fullCalls = 0;
  let traversed = 0;
  let occupied = 0;
  let weightSum = 0;
  let weightedDepth = 0;
  let nearWeightSum = 0;
  let nearWeightedDepth = 0;
  for (let index = 0; index < sampling.count; index++) {
    traversed++;
    const t = interval.entryMeters + (index + samplePhase) * sampling.stepMeters;
    const conservative = evaluate.conservative(t);
    const positive = conservative[0] > 0;
    const chosen = index === 0 || (positive && occupied === 0);
    if (chosen) {
      c4 = conservative;
      witnessDistanceMeters = t;
    }
    if (positive) occupied++;
    if (options.skipEmpty && !positive) continue;
    fullCalls++;
    const medium = evaluate.medium(t, conservative);
    if (chosen) extinctionPerMeter = medium.extinctionPerMeter;
    if (medium.extinctionPerMeter > 0) {
      weightSum += transmittance;
      weightedDepth += t * transmittance;
      if (t <= nearDepth) {
        nearWeightSum += transmittance;
        nearWeightedDepth += t * transmittance;
      }
    }
    const segment = cloudSegmentTransfer(medium, scatterRadiance, sampling.stepMeters);
    // UE includes the boundary source term, but attenuates near T only before it.
    if (t <= nearDepth) {
      nearRadiance[0] += transmittance * segment.radiance[0];
      nearRadiance[1] += transmittance * segment.radiance[1];
      nearRadiance[2] += transmittance * segment.radiance[2];
    }
    if (t < nearDepth) nearTransmittance *= segment.transmittance;
    radiance[0] += transmittance * segment.radiance[0];
    radiance[1] += transmittance * segment.radiance[1];
    radiance[2] += transmittance * segment.radiance[2];
    transmittance *= segment.transmittance;
    opticalDepth += medium.extinctionPerMeter * sampling.stepMeters;
    if (isCloudTraceComplete(transmittance, stopTransmittance)) break;
  }
  const representativeDepthMeters = meanCloudDepth(
    transmittance,
    interval.exitMeters,
    weightSum,
    weightedDepth,
  );
  const publishedTransmittance = publishCloudTransmittance(transmittance, stopTransmittance);
  return {
    near: { radiance: nearRadiance, transmittance: nearTransmittance },
    nearRepresentativeDepthMeters: meanNearCloudDepth(
      interval,
      nearDepth,
      nearWeightSum,
      nearWeightedDepth,
    ),
    trace: {
      ...interval,
      radiance,
      transmittance: publishedTransmittance,
      sceneDepthMeters,
      representativeDepthMeters,
    },
    c4,
    extinctionPerMeter,
    witnessDistanceMeters,
    counts: [sampling.evaluatedCount, traversed, fullCalls, occupied],
    opticalDepth,
  };
}
