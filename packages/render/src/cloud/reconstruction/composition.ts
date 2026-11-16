import type { CloudRgb } from '../contracts';
import type { CloudReconstructionSample, CloudTransport } from './reconstruction';

/** Both transport lanes already include their own atmosphere and height fog. */
export function composeCloudTransport(background: CloudRgb, cloud: CloudTransport): CloudRgb {
  return [0, 1, 2].map((i) => cloud[3] * (background[i] ?? 0) + (cloud[i] ?? 0)) as [
    number,
    number,
    number,
  ];
}

/** Select the side of the traced depth interval nearest the full-resolution surface. */
export function selectCloudDepthTransport(
  sample: CloudReconstructionSample,
  sceneDepthMeters: number,
): CloudTransport {
  const nearDistance = Math.abs(sceneDepthMeters - sample.depthMeters[2]);
  const farDistance = Math.abs(sceneDepthMeters - sample.depthMeters[3]);
  return nearDistance < farDistance ? sample.near : sample.far;
}

export function bilateralCloudUpsample(
  samples: readonly CloudReconstructionSample[],
  sceneDepthMeters: number,
  spatialWeights: readonly number[],
  disableDisocclusionDistanceMeters = 5000,
): CloudTransport {
  if (samples.length === 0 || samples.length !== spatialWeights.length)
    throw new RangeError('Cloud upsample needs paired samples and weights');
  const result = [0, 0, 0, 0];
  if (
    samples.every(
      (sample) =>
        sample.depthMeters[0] > sceneDepthMeters + 1 &&
        sample.depthMeters[2] > sceneDepthMeters + 1,
    )
  )
    return [0, 0, 0, 1];
  const allInFront = samples.every((sample) => sample.depthMeters[0] <= sample.depthMeters[2]);
  const depths = samples.flatMap((sample) => [sample.depthMeters[2], sample.depthMeters[3]]);
  const range = Math.max(...depths) - Math.min(...depths);
  const allDistant = samples.every((sample) =>
    sample.depthMeters.slice(1).every((v) => v >= disableDisocclusionDistanceMeters),
  );
  if (!(allInFront && (range < 1000 || allDistant))) {
    let closest = Number.POSITIVE_INFINITY;
    let selected: CloudTransport = [0, 0, 0, 1];
    for (const sample of samples) {
      const distance = Math.min(
        Math.abs(sceneDepthMeters - sample.depthMeters[2]),
        Math.abs(sceneDepthMeters - sample.depthMeters[3]),
      );
      if (distance < closest) {
        closest = distance;
        selected = selectCloudDepthTransport(sample, sceneDepthMeters);
      }
    }
    return selected;
  }
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample === undefined) continue;
    const transport = sample.far;
    const weight = Math.max(0, spatialWeights[i] ?? 0);
    total += weight;
    for (let c = 0; c < 4; c++) result[c] = (result[c] ?? 0) + (transport[c] ?? 0) * weight;
  }
  return total > 0
    ? (result.map((v) => v / total) as [number, number, number, number])
    : [0, 0, 0, 1];
}
