import type { LightResourceUnavailableError } from '../../errors/render';
import {
  type LightInspection,
  lightInspectionIdentity,
  projectLightInspection,
} from '../../inspection-types';
import type { ExtendedLightingResourceCandidate } from './resources';

export type ExtendedLightingResourceStatus = 'empty' | 'candidate' | 'accepted';

export interface ExtendedLightingState {
  readonly enabled: boolean;
  readonly generation: number;
  readonly status: ExtendedLightingResourceStatus;
  readonly candidate: ExtendedLightingResourceCandidate | undefined;
  readonly accepted: ExtendedLightingResourceCandidate | undefined;
  readonly lastKnownGood: ExtendedLightingResourceCandidate | undefined;
  readonly resourceCount: number;
  readonly descriptorBytes: number;
  readonly uploadCount: number;
  readonly passCount: number;
  readonly bindGroupCount: number;
  readonly failure: LightResourceUnavailableError | undefined;
  readonly failureKeys: readonly string[];
}

export function createExtendedLightingState(generation: number): ExtendedLightingState {
  return {
    enabled: false,
    generation,
    status: 'empty',
    candidate: undefined,
    accepted: undefined,
    lastKnownGood: undefined,
    resourceCount: 0,
    descriptorBytes: 0,
    uploadCount: 0,
    passCount: 0,
    bindGroupCount: 0,
    failure: undefined,
    failureKeys: [],
  };
}

export function promoteExtendedLightingCandidate(
  state: ExtendedLightingState,
  candidate: ExtendedLightingResourceCandidate | undefined,
): ExtendedLightingState {
  if (candidate === undefined) return state;
  return {
    ...state,
    enabled: true,
    generation: candidate.generation,
    status: 'accepted',
    candidate: undefined,
    accepted: candidate,
    lastKnownGood: candidate,
    resourceCount: 4,
    descriptorBytes: candidate.descriptorBytes,
    uploadCount: candidate.uploadCount,
  };
}

export function recordExtendedLightingFailure(
  state: ExtendedLightingState,
  failure: LightResourceUnavailableError,
): ExtendedLightingState {
  const key = `${failure.detail.entity}:${failure.detail.feature}:${failure.detail.generation}`;
  if (state.failureKeys.includes(key)) return state;
  return {
    ...state,
    failure,
    failureKeys: [...state.failureKeys, key],
  };
}

export function projectExtendedLightingInspection(state: ExtendedLightingState): LightInspection {
  const identity = (candidate: ExtendedLightingResourceCandidate | undefined) =>
    candidate === undefined
      ? undefined
      : lightInspectionIdentity(candidate.topology, candidate.generation);
  return projectLightInspection({
    generation: state.generation,
    candidate: identity(state.candidate),
    accepted: identity(state.accepted),
    lastKnownGood: identity(state.lastKnownGood),
    failure: state.failure?.code,
    failureKeys: state.failureKeys,
    resourceCount: state.resourceCount,
    uploadBytes: state.descriptorBytes,
  });
}
