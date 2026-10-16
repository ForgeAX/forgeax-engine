import type { VolumeProjectorTuple } from './temporal';

export interface VolumeSelectedLightFacts {
  readonly entity: number;
  readonly kind: 'directional' | 'point' | 'spot';
  readonly revision: number;
  readonly shadowTile: number;
  readonly pointLightEntity?: number;
  readonly spotLightEntity?: number;
  readonly projector?: VolumeProjectorTuple;
}

export interface VolumeRecoveryState {
  readonly guid: string;
  readonly generation: number;
  readonly deviceEpoch: number;
  readonly status: 'accepted' | 'candidate' | 'degraded' | 'recovering';
  readonly candidateGeneration?: number;
  readonly candidateDigest?: string;
  readonly lkgGeneration?: number;
  readonly candidateFailure?:
    | 'submit-failed'
    | 'stale-generation'
    | 'missing-selected-light'
    | 'missing-shadow';
  readonly selectedLight?: VolumeSelectedLightFacts;
  readonly candidateSelectedLight?: VolumeSelectedLightFacts;
}

export type VolumeRecoveryEvent =
  | { readonly kind: 'submit-failed' }
  | { readonly kind: 'device-lost'; readonly deviceEpoch: number }
  | { readonly kind: 'accepted'; readonly generation: number };

export function stageVolumetricFog(
  state: VolumeRecoveryState,
  candidate: {
    readonly generation: number;
    readonly digest: string;
    readonly selectedLight?: VolumeSelectedLightFacts;
  },
): VolumeRecoveryState {
  return {
    ...state,
    status: 'candidate',
    candidateGeneration: candidate.generation,
    candidateDigest: candidate.digest,
    ...(candidate.selectedLight === undefined
      ? {}
      : { candidateSelectedLight: candidate.selectedLight }),
  };
}

export function recoverVolumetricFog(
  state: VolumeRecoveryState,
  event: VolumeRecoveryEvent,
): VolumeRecoveryState {
  if (event.kind === 'device-lost') {
    return { ...state, status: 'recovering', deviceEpoch: event.deviceEpoch };
  }
  if (event.kind === 'submit-failed') {
    return {
      ...state,
      status: 'degraded',
      lkgGeneration: state.generation,
      candidateFailure: 'submit-failed',
    };
  }
  const expectedGeneration = state.candidateGeneration ?? state.generation;
  if (state.status === 'degraded' || event.generation !== expectedGeneration) {
    return {
      ...state,
      status: 'degraded',
      lkgGeneration: state.generation,
      candidateFailure: 'stale-generation',
    };
  }
  return {
    ...state,
    status: 'accepted',
    lkgGeneration: state.generation,
    ...(state.candidateSelectedLight === undefined
      ? {}
      : { selectedLight: state.candidateSelectedLight }),
  };
}
