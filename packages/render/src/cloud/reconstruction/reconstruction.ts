export type CloudTransport = readonly [number, number, number, number];
export interface CloudReconstructionSample {
  readonly far: CloudTransport;
  readonly near: CloudTransport;
  /** Representative cloud depth, scene depth, minimum and maximum scene depths, all in meters. */
  readonly depthMeters: readonly [number, number, number, number];
}

export function cloudMode0Layout(width: number, height: number) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('Cloud viewport dimensions must be positive integers');
  }
  const reconstruct = { width: Math.ceil(width / 2), height: Math.ceil(height / 2) };
  return {
    full: { width, height },
    reconstruct,
    trace: { width: Math.ceil(reconstruct.width / 2), height: Math.ceil(reconstruct.height / 2) },
  };
}

export interface CloudReconstructionInput {
  readonly current: CloudReconstructionSample;
  readonly history?: CloudReconstructionSample;
  readonly historyUv: readonly [number, number];
  readonly pixel: readonly [number, number];
  readonly pixelOffset: readonly [number, number];
  readonly currentExposure: number;
  readonly historyExposure: number;
  readonly minimumReprojectionDistanceMeters: number;
  readonly disableDisocclusionDistanceMeters: number;
}

export type CloudReconstructionReason =
  | 'phase'
  | 'cold'
  | 'outside'
  | 'too-near'
  | 'depth'
  | 'history';

function exposed(value: CloudTransport, ratio: number): CloudTransport {
  return [value[0] * ratio, value[1] * ratio, value[2] * ratio, value[3]];
}

/** Mode 0 min/max-depth permutation. Spatial cold-fill is supplied by the texture sampler. */
export function selectCloudReconstructionSample(input: CloudReconstructionInput): {
  readonly sample: CloudReconstructionSample;
  readonly reason: CloudReconstructionReason;
} {
  let reason: CloudReconstructionReason = 'history';
  const current = input.current;
  const history = input.history;
  if (input.pixel[0] % 2 === input.pixelOffset[0] && input.pixel[1] % 2 === input.pixelOffset[1])
    reason = 'phase';
  else if (history === undefined) reason = 'cold';
  else if (!input.historyUv.every((v) => v > 0 && v < 1)) reason = 'outside';
  else if (current.depthMeters[0] < input.minimumReprojectionDistanceMeters) reason = 'too-near';
  else {
    const n = current.depthMeters;
    const h = history.depthMeters;
    const disocclusion = [...n.slice(1), ...h.slice(1)].some(
      (v) => v < input.disableDisocclusionDistanceMeters,
    );
    if (
      (disocclusion &&
        ((Math.abs(n[2] - n[3]) > 2000 && Math.abs(n[2] - n[1]) < Math.abs(n[3] - n[1])) ||
          Math.abs(h[1] - n[1]) > 2000)) ||
      Math.abs(n[2] - h[2]) > 1000
    )
      reason = 'depth';
  }
  if (reason !== 'history' || history === undefined) return { sample: current, reason };
  if (
    !Number.isFinite(input.currentExposure) ||
    input.currentExposure <= 0 ||
    !Number.isFinite(input.historyExposure) ||
    input.historyExposure <= 0
  ) {
    throw new RangeError('Cloud exposure must be positive and finite');
  }
  const ratio = input.currentExposure / input.historyExposure;
  return {
    sample: { ...history, far: exposed(history.far, ratio), near: exposed(history.near, ratio) },
    reason,
  };
}
