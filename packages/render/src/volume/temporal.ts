export interface VolumeTemporalSignature {
  readonly cameraRevision: number;
  readonly fogRevision: number;
  readonly lightRevision: number;
  readonly densityGeneration: number;
  readonly width: number;
  readonly height: number;
  /** World-owned authored-medium time; render frame identity never advances the medium. */
  readonly worldTimeSeconds?: number;
  readonly lightKind?: 'directional' | 'point' | 'spot';
  readonly lightEntity?: number;
  readonly pointLightEntity?: number;
  readonly spotLightEntity?: number;
  readonly projector?: VolumeProjectorTuple;
  readonly lightShadowRevision?: number;
}

/** Accepted projector facts shared by surface and volume consumers. */
export interface VolumeProjectorTuple {
  readonly guid: string;
  readonly generation: number;
  readonly view: string;
  readonly sampler: string;
  readonly projection: string;
  readonly revision: number;
}

export type VolumeTemporalResetReason =
  | 'camera-cut'
  | 'fog-revision'
  | 'light-revision'
  | 'density-generation'
  | 'simulation-time'
  | 'resize'
  | 'reprojection-out-of-screen'
  | 'reprojection-depth-discontinuity';

export type VolumeTemporalReset =
  | { readonly reset: false }
  | { readonly reset: true; readonly reason: VolumeTemporalResetReason };

export function resolveVolumeTemporalReset(
  previous: VolumeTemporalSignature,
  next: VolumeTemporalSignature,
  options: {
    readonly taaEnabled?: boolean;
    readonly reprojection?: 'out-of-screen' | 'depth-discontinuity';
  } = {},
): VolumeTemporalReset {
  if (options.reprojection === 'out-of-screen') {
    return { reset: true, reason: 'reprojection-out-of-screen' };
  }
  if (options.reprojection === 'depth-discontinuity') {
    return { reset: true, reason: 'reprojection-depth-discontinuity' };
  }
  if (previous.width !== next.width || previous.height !== next.height) {
    return { reset: true, reason: 'resize' };
  }
  if (previous.cameraRevision !== next.cameraRevision) return { reset: true, reason: 'camera-cut' };
  if (previous.fogRevision !== next.fogRevision) return { reset: true, reason: 'fog-revision' };
  if (previous.lightRevision !== next.lightRevision) {
    return { reset: true, reason: 'light-revision' };
  }
  if (previous.lightKind !== next.lightKind || previous.lightEntity !== next.lightEntity) {
    return { reset: true, reason: 'light-revision' };
  }
  if (
    previous.pointLightEntity !== next.pointLightEntity ||
    previous.spotLightEntity !== next.spotLightEntity
  ) {
    return { reset: true, reason: 'light-revision' };
  }
  const previousProjector = previous.projector;
  const nextProjector = next.projector;
  if (
    previousProjector?.guid !== nextProjector?.guid ||
    previousProjector?.generation !== nextProjector?.generation ||
    previousProjector?.view !== nextProjector?.view ||
    previousProjector?.sampler !== nextProjector?.sampler ||
    previousProjector?.projection !== nextProjector?.projection ||
    previousProjector?.revision !== nextProjector?.revision
  ) {
    return { reset: true, reason: 'light-revision' };
  }
  if (previous.lightShadowRevision !== next.lightShadowRevision) {
    return { reset: true, reason: 'light-revision' };
  }
  if (previous.worldTimeSeconds !== next.worldTimeSeconds) {
    const delta = (next.worldTimeSeconds ?? NaN) - (previous.worldTimeSeconds ?? NaN);
    // Small monotonic ticks animate the same medium. Reset only on a clock
    // discontinuity; rejecting every tick prevents temporal reuse in live play.
    if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) {
      return { reset: true, reason: 'simulation-time' };
    }
  }
  if (previous.densityGeneration !== next.densityGeneration) {
    return { reset: true, reason: 'density-generation' };
  }
  return { reset: false };
}
